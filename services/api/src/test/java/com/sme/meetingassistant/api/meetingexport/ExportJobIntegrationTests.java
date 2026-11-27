package com.sme.meetingassistant.api.meetingexport;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import com.sme.meetingassistant.api.meetingminutes.MinutesSnapshot;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.time.OffsetDateTime;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.text.PDFTextStripper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.web.context.request.RequestAttributes;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import tools.jackson.databind.ObjectMapper;

/** Real PostgreSQL/Flyway V36; fake private object bytes only, not fake DB state. */
@ActiveProfiles("test")
@SpringBootTest(properties={
    "app.media.outbox.enabled=false",
    "app.exports.worker.enabled=false",
    "app.exports.worker.retry-base-seconds=1",
    "app.exports.worker.max-attempts=2"
})
@Import({PostgresTestConfiguration.class, ExportJobIntegrationTests.TestStorage.class})
class ExportJobIntegrationTests {
    @TestConfiguration(proxyBeanMethods=false)
    static class TestStorage {
        @Bean @Primary
        InMemoryExportStore verifiedPrivateStore() { return new InMemoryExportStore(); }
    }

    static final class InMemoryExportStore implements ExportArtifactStore {
        final Map<String, byte[]> objects = new ConcurrentHashMap<>();
        volatile boolean failArtifact;
        volatile boolean failIntake;

        @Override
        public void putVerified(String key, byte[] bytes, String mediaType, String digest) {
            if ((failArtifact && key.contains("/artifacts/"))
                    || (failIntake && key.contains("/intake/"))) {
                throw new StorageFailure("Test-only object-store outage",
                        new IllegalStateException("network unavailable"));
            }
            if (!ExportSnapshotCodec.sha256(bytes).equals(digest)) {
                throw new IntegrityFailure("Invalid store digest");
            }
            byte[] original = objects.putIfAbsent(key, bytes.clone());
            if (original != null && !Arrays.equals(original, bytes)) {
                throw new IntegrityFailure("Immutable key collision");
            }
        }

        @Override
        public void putLegacySnapshotVerified(String key, byte[] bytes,
                java.util.function.Predicate<byte[]> sameFrozenContent) {
            byte[] original = objects.putIfAbsent(key, bytes.clone());
            if (original != null && (original.length != bytes.length
                    || (!Arrays.equals(original, bytes) && !sameFrozenContent.test(original)))) {
                throw new IntegrityFailure("Immutable legacy snapshot collision");
            }
        }

        @Override
        public byte[] readVerified(String key, String digest, int limit) {
            byte[] bytes = objects.get(key);
            if (bytes == null) {
                throw new StorageFailure("Missing private source", new IllegalStateException());
            }
            if (bytes.length > limit || !digest.equals(ExportSnapshotCodec.sha256(bytes))) {
                throw new IntegrityFailure("Damaged private source");
            }
            return bytes.clone();
        }

        void clear() {
            objects.clear();
            failArtifact = false;
            failIntake = false;
        }
    }

    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired ExportJobProcessor worker;
    @Autowired ExportSubmissionService submissions;
    @Autowired ExportIntentService intents;
    @Autowired ExportGenerationStateMachine state;
    @Autowired MeetingExportRepository records;
    @Autowired InMemoryExportStore storage;
    @Autowired ExportIntakeRepository intakeRepository;
    @Autowired ExportOperationalMetrics metrics;
    @Autowired com.sme.meetingassistant.api.meetingexport.render.MarkdownMinutesRenderer markdown;
    @Autowired com.sme.meetingassistant.api.meetingexport.render.PdfMinutesRenderer pdfRenderer;

    @BeforeEach
    void clear() {
        storage.clear();
        for (int i = 0; i < 60; i++) {
            var orphan = state.claimNext(30);
            if (orphan.isEmpty()) break;
            state.fail(orphan.get().id(), orphan.get().claimToken(), "TEST_FIXTURE_CLEANUP");
        }
    }

    @Test
    void completedMarkdownAndPdfAreDurableAndChecksumVerified() throws Exception {
        UUID owner = user(), meeting = meeting(owner);
        MinutesSnapshot source = snapshot(meeting,owner,"Phê duyệt kế hoạch mới");
        ExportRecord md = as(owner, () -> submissions.submit(meeting,
                ExportFormat.MARKDOWN, "md-task", source));
        ExportRecord pdf = as(owner, () -> submissions.submit(meeting,
                ExportFormat.PDF, "pdf-task", source));
        assertThat(md.status()).isEqualTo(ExportStatus.PENDING);
        assertThat(pdf.status()).isEqualTo(ExportStatus.PENDING);
        // Transactional admission audit exists only for committed new intake.
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM audit_events
             WHERE action_code='EXPORT_INTENT_ADMITTED' AND entity_id=?
            """,Long.class,pdf.id())).isEqualTo(1L);
        assertThat(state.claimNextStaged(30)).isPresent();
        // Restore first claim to a safe terminal state and create a new export
        // to prove dispatch only picks currently PENDING, fully staged rows.
        var first = records.require(md.id());
        assertThat(first.status()).isEqualTo(ExportStatus.GENERATING);
        assertThat(state.fail(first.id(),first.claimToken(),"TEST_FIXTURE_CLEANUP")).isTrue();

        assertThat(worker.processNext()).isTrue();
        ExportRecord readyPdf = records.require(pdf.id());
        assertThat(readyPdf.status()).isEqualTo(ExportStatus.READY);
        assertThat(readyPdf.sourceFingerprint()).isEqualTo(source.sourceFingerprint());
        assertThat(readyPdf.snapshotObjectKey()).isNotNull();
        assertThat(readyPdf.artifactSizeBytes()).isGreaterThan(100L);
        byte[] document = storage.readVerified(readyPdf.objectKey(),
                readyPdf.artifactSha256(), 32*1024*1024);
        try(var parsed = Loader.loadPDF(document)) {
            String text = new PDFTextStripper().getText(parsed);
            assertThat(text).contains("Biên bản", "Phê duyệt kế hoạch mới");
        }
        ExportRecord anotherMd = as(owner, () -> submissions.submit(meeting,
                ExportFormat.MARKDOWN,"md-second",source));
        assertThat(worker.processNext()).isTrue();
        ExportRecord readyMd = records.require(anotherMd.id());
        assertThat(readyMd.status()).isEqualTo(ExportStatus.READY);
        assertThat(new String(storage.readVerified(readyMd.objectKey(),
                readyMd.artifactSha256(), 8*1024*1024),
                java.nio.charset.StandardCharsets.UTF_8))
                .contains("Phê duyệt kế hoạch mới","Source fingerprint");
    }

    @Test
    void versionedIntakeSurvivesReplayAndLegacyPendingWorkUsesOriginalRenderer() throws Exception {
        UUID owner = user(), meeting = meeting(owner);
        MinutesSnapshot base = snapshot(meeting, owner, "Nội dung có người phụ trách");
        var action = new MinutesSnapshot.Action(UUID.randomUUID(), "Kiểm tra báo cáo", null,
                "OPEN", "MANUAL", owner, null, 0L, base.assembledAt(), null, null);
        var canonical = new MinutesSnapshot.CanonicalContent(1, "COMPLETE", base.meeting(),
                base.summary(), List.of(), List.of(action), base.transcript(), List.of(), false);
        String hash = ExportSnapshotCodec.sha256(json.writeValueAsBytes(canonical));
        var source = new MinutesSnapshot(1, base.assembledAt(), hash, "COMPLETE", base.meeting(),
                base.summary(), List.of(), List.of(action), base.transcript(), List.of(), false,
                new MinutesSnapshot.DisplayMetadata(Map.of(owner, "Nguyễn Văn An")));
        var renamed = new MinutesSnapshot(1, base.assembledAt(), hash, "COMPLETE", base.meeting(),
                base.summary(), List.of(), List.of(action), base.transcript(), List.of(), false,
                new MinutesSnapshot.DisplayMetadata(Map.of(owner, "Người đổi tên")));

        // Reproduce an existing, still-pending intake as written by the old code.
        ExportRecord legacy = as(owner, () -> intents.create(meeting, ExportFormat.MARKDOWN, "legacy"));
        byte[] legacyBytes = json.writeValueAsBytes(new ExportSnapshotCodec.Envelope(
                1, legacy.id(), meeting, owner, source));
        String digest = ExportSnapshotCodec.sha256(legacyBytes);
        String key = "exports/" + legacy.id() + "/intake/" + digest + ".json";
        storage.putVerified(key, legacyBytes, "application/json", digest);
        jdbc.update("""
            INSERT INTO meeting_export_intakes(export_id,meeting_id,requested_by_user_id,
                source_fingerprint,intake_sha256,object_key) VALUES(?,?,?,?,?,?)
            """, legacy.id(), meeting, owner, hash, digest, key);
        assertThat(worker.processNext()).isTrue();
        var legacyReady = records.require(legacy.id());
        assertThat(legacyReady.status()).isEqualTo(ExportStatus.READY);
        assertThat(legacyReady.rendererVersion()).isEqualTo("markdown-v1");
        assertThat(new String(storage.readVerified(legacyReady.objectKey(),
                legacyReady.artifactSha256(), 8*1024*1024), java.nio.charset.StandardCharsets.UTF_8))
                .doesNotContain("Nguyễn Văn An");

        ExportRecord current = as(owner, () -> submissions.submit(meeting,
                ExportFormat.MARKDOWN, "enriched", source));
        assertThat(as(owner, () -> submissions.submit(meeting,
                ExportFormat.MARKDOWN, "enriched", renamed)).id()).isEqualTo(current.id());
        assertThat(worker.processNext()).isTrue();
        var ready = records.require(current.id());
        assertThat(ready.status()).isEqualTo(ExportStatus.READY);
        assertThat(ready.rendererVersion()).isEqualTo("markdown-v2");
        String intakeKey = jdbc.queryForObject("SELECT object_key FROM meeting_export_intakes WHERE export_id=?",
                String.class, current.id());
        assertThat(storage.objects.get(ready.snapshotObjectKey())).isEqualTo(
                json.writeValueAsBytes(json.readTree(storage.objects.get(intakeKey)).path("snapshot")));
        assertThat(ready.sourceFingerprint()).isEqualTo(hash);
        assertThat(new String(storage.readVerified(ready.objectKey(), ready.artifactSha256(),
                8*1024*1024), java.nio.charset.StandardCharsets.UTF_8))
                .contains("Nguyễn Văn An").doesNotContain("Người đổi tên");
    }

    @Test
    void multiAssigneeLegacyAndCurrentIntakesRecoverAfterWorkerReplacement() throws Exception {
        UUID owner = user(), second = user(), meeting = meeting(owner);
        MinutesSnapshot base = snapshot(meeting, owner, "Nội dung nhiều người phụ trách");
        var actions = List.of(
                new MinutesSnapshot.Action(UUID.randomUUID(), "Việc thứ nhất", null,
                        "OPEN", "MANUAL", owner, null, 0L, base.assembledAt(), null, null),
                new MinutesSnapshot.Action(UUID.randomUUID(), "Việc thứ hai", null,
                        "OPEN", "MANUAL", second, null, 0L, base.assembledAt(), null, null));
        var canonical = new MinutesSnapshot.CanonicalContent(1, "COMPLETE", base.meeting(),
                base.summary(), List.of(), actions, base.transcript(), List.of(), false);
        String hash = ExportSnapshotCodec.sha256(json.writeValueAsBytes(canonical));
        var source = new MinutesSnapshot(1, base.assembledAt(), hash, "COMPLETE", base.meeting(),
                base.summary(), List.of(), actions, base.transcript(), List.of(), false,
                new MinutesSnapshot.DisplayMetadata(Map.of(owner, "Nguyễn Văn An", second, "Trần Thị Bình")));

        for (int version : List.of(1, 2)) {
            ExportRecord pending;
            if (version == 1) {
                pending = as(owner, () -> intents.create(meeting, ExportFormat.MARKDOWN, "restart-v1"));
                byte[] frozen = json.writeValueAsBytes(new ExportSnapshotCodec.Envelope(
                        1, pending.id(), meeting, owner, source));
                String digest = ExportSnapshotCodec.sha256(frozen);
                String key = "exports/" + pending.id() + "/intake/" + digest + ".json";
                storage.putVerified(key, frozen, "application/json", digest);
                jdbc.update("""
                    INSERT INTO meeting_export_intakes(export_id,meeting_id,requested_by_user_id,
                        source_fingerprint,intake_sha256,object_key) VALUES(?,?,?,?,?,?)
                    """, pending.id(), meeting, owner, hash, digest, key);
            } else {
                pending = as(owner, () -> submissions.submit(meeting,
                        ExportFormat.PDF, "restart-v2", source));
            }
            storage.failArtifact = true;
            assertThat(worker.processNext()).isTrue();
            var failed = records.require(pending.id());
            assertThat(failed.status()).isEqualTo(ExportStatus.FAILED);
            assertThat(failed.lastErrorCode()).isEqualTo("EXPORT_STORAGE_UNAVAILABLE");
            String snapshotKey = failed.snapshotObjectKey();
            assertThat(snapshotKey).isNotNull();
            byte[] firstBytes = storage.objects.get(snapshotKey).clone();

            if (version == 1) {
                // Explicitly reproduce a different JVM's unordered-map serialization;
                // merely creating a second instance in this JVM cannot change its salt.
                var node = (tools.jackson.databind.node.ObjectNode) json.readTree(firstBytes);
                var metadata = (tools.jackson.databind.node.ObjectNode) node.path("displayMetadata");
                var entries = new java.util.ArrayList<>(
                        metadata.path("assigneeDisplayNames").properties());
                java.util.Collections.reverse(entries);
                var reversed = json.createObjectNode();
                for (var entry : entries) reversed.set(entry.getKey(), entry.getValue());
                metadata.set("assigneeDisplayNames", reversed);
                byte[] previousJvmBytes = json.writeValueAsBytes(node);
                assertThat(Arrays.equals(previousJvmBytes, firstBytes)).isFalse();
                storage.objects.put(snapshotKey, previousJvmBytes);
                firstBytes = previousJvmBytes;
            }

            storage.failArtifact = false;
            awaitRetryEligibility(pending.id());
            var replacement = new ExportJobProcessor(state, intakeRepository, storage,
                    new ExportSnapshotCodec(json), markdown, pdfRenderer, jdbc, metrics, 30, 2, 1);
            try {
                replacement.reconcile();
                assertThat(records.require(pending.id()).status()).isEqualTo(ExportStatus.PENDING);
                assertThat(replacement.processNext()).isTrue();
            } finally {
                replacement.close();
            }
            var ready = records.require(pending.id());
            assertThat(ready.status()).isEqualTo(ExportStatus.READY);
            assertThat(ready.generationAttempt()).isEqualTo(2);
            assertThat(ready.snapshotObjectKey()).isEqualTo(snapshotKey);
            assertThat(storage.objects.get(snapshotKey)).isEqualTo(firstBytes);
            assertThat(ready.sourceFingerprint()).isEqualTo(hash);
            byte[] artifact = storage.readVerified(ready.objectKey(), ready.artifactSha256(), 32*1024*1024);
            if (version == 1) {
                assertThat(ready.rendererVersion()).isEqualTo("markdown-v1");
                assertThat(new String(artifact, java.nio.charset.StandardCharsets.UTF_8))
                        .contains("- **Người phụ trách (ID):** " + owner.toString().replace("-", "\\-"),
                                "- **Người phụ trách (ID):** " + second.toString().replace("-", "\\-"))
                        .doesNotContain("Nguyễn Văn An", "Trần Thị Bình");
            } else {
                assertThat(ready.rendererVersion()).isEqualTo("pdf-v2-markdown-v2-dejavu-2.29");
                try (var parsed = Loader.loadPDF(artifact)) {
                    assertThat(new PDFTextStripper().getText(parsed))
                            .contains("Nguyễn Văn An", "Trần Thị Bình");
                }
            }
        }
    }

    @Test
    void idempotentReplayRetainsOriginalVerifiedSourceNotLatestChangedMeeting() {
        UUID owner=user(), meeting=meeting(owner);
        MinutesSnapshot original=snapshot(meeting,owner,"Nội dung gốc");
        MinutesSnapshot changed=snapshot(meeting,owner,"Nội dung đã thay đổi");
        ExportRecord first=as(owner, () -> submissions.submit(meeting,
                ExportFormat.MARKDOWN,"same-retry-key",original));
        ExportRecord replay=as(owner, () -> submissions.submit(meeting,
                ExportFormat.MARKDOWN,"same-retry-key",changed));
        assertThat(replay.id()).isEqualTo(first.id());
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM audit_events
             WHERE action_code='EXPORT_INTENT_ADMITTED' AND entity_id=?
            """,Long.class,first.id())).isEqualTo(1L);
        assertThat(worker.processNext()).isTrue();
        ExportRecord ready=records.require(first.id());
        assertThat(ready.sourceFingerprint()).isEqualTo(original.sourceFingerprint())
                .isNotEqualTo(changed.sourceFingerprint());
        String text=new String(storage.readVerified(ready.objectKey(),
                ready.artifactSha256(),8*1024*1024),
                java.nio.charset.StandardCharsets.UTF_8);
        assertThat(text).contains("Nội dung gốc").doesNotContain("Nội dung đã thay đổi");
    }

    @Test
    void rejectedPrivateIntakeWriteRollsBackWholeDurableExportIntent() {
        UUID owner=user(), meeting=meeting(owner);
        storage.failIntake=true;
        assertThatThrownBy(() -> as(owner, () -> submissions.submit(meeting,
                ExportFormat.PDF,"unavailable",snapshot(meeting,owner,"Nội dung"))))
                .isInstanceOf(ExportArtifactStore.StorageFailure.class);
        assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM meeting_exports WHERE meeting_id=?",
                Long.class,meeting)).isZero();
        assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM meeting_export_idempotency WHERE meeting_id=?",
                Long.class,meeting)).isZero();
    }

    @Test
    void transientArtifactFailureNeverMarksReadyAndRetriesWithSamePinnedIntake()
            throws Exception {
        UUID owner=user(),meeting=meeting(owner);
        ExportRecord pending=as(owner, () -> submissions.submit(meeting,
                ExportFormat.MARKDOWN,"storage-retry",snapshot(meeting,owner,"Cần giữ nguyên")));
        storage.failArtifact=true;
        assertThat(worker.processNext()).isTrue();
        ExportRecord failed=records.require(pending.id());
        assertThat(failed.status()).isEqualTo(ExportStatus.FAILED);
        assertThat(failed.generationAttempt()).isEqualTo(1);
        assertThat(failed.lastErrorCode()).isEqualTo("EXPORT_STORAGE_UNAVAILABLE");
        assertThat(records.requireStatus(pending.id(), 2).retryEligible()).isTrue();
        assertThat(records.requireStatus(pending.id(), 1).retryEligible()).isFalse();
        assertThat(failed.readyAt()).isNull();
        assertThat(failed.objectKey()).isNull();

        storage.failArtifact=false;
        awaitRetryEligibility(pending.id());
        worker.reconcile();
        assertThat(records.require(pending.id()).status()).isEqualTo(ExportStatus.PENDING);
        assertThat(records.requireStatus(pending.id(), 2).retryEligible()).isFalse();
        assertThat(worker.processNext()).isTrue();
        ExportRecord ready=records.require(pending.id());
        assertThat(ready.status()).isEqualTo(ExportStatus.READY);
        assertThat(ready.generationAttempt()).isEqualTo(2);
        assertThat(ready.claimToken()).isNull();
        assertThat(ready.snapshotObjectKey()).isNotNull();
    }

    private void awaitRetryEligibility(UUID exportId) throws InterruptedException {
        int maxAttempts = 2;
        int retryBaseSeconds = 1;
        long deadline = System.nanoTime()
                + java.util.concurrent.TimeUnit.SECONDS.toNanos(10);
        Map<String, Object> diagnostics = Map.of();
        while (System.nanoTime() < deadline) {
            var rows = jdbc.queryForList("""
                SELECT clock_timestamp() AS db_clock, e.status, e.updated_at,
                       e.last_error_code, e.generation_attempt,
                       (i.export_id IS NOT NULL) AS intake_exists,
                       (e.generation_attempt < ?) AS attempts_available,
                       (e.last_error_code IN
                           ('EXPORT_STORAGE_UNAVAILABLE','EXPORT_LEASE_EXPIRED'))
                           AS transient_error,
                       (e.updated_at <= clock_timestamp() -
                           ((? * (1 << LEAST(e.generation_attempt-1, 10)))
                             * INTERVAL '1 second')) AS retry_due,
                       (e.status='FAILED'
                        AND e.generation_attempt < ?
                        AND e.last_error_code IN
                            ('EXPORT_STORAGE_UNAVAILABLE','EXPORT_LEASE_EXPIRED')
                        AND i.export_id IS NOT NULL
                        AND e.updated_at <= clock_timestamp() -
                            ((? * (1 << LEAST(e.generation_attempt-1, 10)))
                              * INTERVAL '1 second')) AS retry_eligible
                  FROM meeting_exports e
                  LEFT JOIN meeting_export_intakes i ON i.export_id=e.id
                 WHERE e.id=?
                """, maxAttempts, retryBaseSeconds, maxAttempts,
                    retryBaseSeconds, exportId);
            if (rows.size() == 1) {
                diagnostics = rows.getFirst();
                if (Boolean.TRUE.equals(diagnostics.get("retry_eligible"))) return;
            }
            Thread.sleep(50L);
        }
        throw new AssertionError("Export retry did not become eligible: " + diagnostics);
    }

    @Test
    void tamperedSourceCannotReachReadyOrRetryAsTransient() {
        UUID owner=user(),meeting=meeting(owner);
        ExportRecord pending=as(owner, () -> submissions.submit(meeting,
                ExportFormat.MARKDOWN,"integrity",snapshot(meeting,owner,"Gốc")));
        String key=jdbc.queryForObject(
                "SELECT object_key FROM meeting_export_intakes WHERE export_id=?",
                String.class,pending.id());
        storage.objects.put(key, "tampered".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        assertThat(worker.processNext()).isTrue();
        ExportRecord failed=records.require(pending.id());
        assertThat(failed.status()).isEqualTo(ExportStatus.FAILED);
        assertThat(failed.lastErrorCode()).isEqualTo("EXPORT_STORAGE_INTEGRITY");
        assertThat(records.requireStatus(pending.id(), 2).retryEligible()).isFalse();
        worker.reconcile();
        assertThat(records.require(pending.id()).status()).isEqualTo(ExportStatus.FAILED);
    }

    @Test
    void backlogLimitsDistinctKeysButNotReplayAndRollsBackExceededReceipt() {
        UUID actor=user(), meeting=meeting(actor);
        MinutesSnapshot source=snapshot(meeting,actor,"Giới hạn nguồn lực");
        ExportRecord first=null;
        for (int i=0;i<5;i++) {
            final int n=i;
            ExportRecord created=as(actor,()->submissions.submit(meeting,
                    ExportFormat.MARKDOWN,"admission-limit-"+n,source));
            if(i==0) first=created;
        }
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_exports
             WHERE meeting_id=? AND status='PENDING'
            """,Long.class,meeting)).isEqualTo(5L);
        assertThatThrownBy(()->as(actor,()->submissions.submit(meeting,
                ExportFormat.MARKDOWN,"admission-limit-over",source)))
                .isInstanceOf(org.springframework.web.server.ResponseStatusException.class)
                .hasMessageContaining("429");
        UUID original=first.id();
        ExportRecord replay=as(actor,()->submissions.submit(meeting,
                ExportFormat.MARKDOWN,"admission-limit-0",source));
        assertThat(replay.id()).isEqualTo(original);
        assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM meeting_exports WHERE meeting_id=?",
                Long.class,meeting)).isEqualTo(5L);
    }

    @Test
    void concurrentDistinctIdempotencyKeysCannotRacePastTheDatabaseQuota()
            throws Exception {
        UUID actor=user(), meeting=meeting(actor);
        MinutesSnapshot source=snapshot(meeting,actor,"Tải đồng thời");
        var pool=java.util.concurrent.Executors.newFixedThreadPool(8);
        try {
            java.util.List<java.util.concurrent.Future<Boolean>> results =
                    new java.util.ArrayList<>();
            for(int i=0;i<8;i++) {
                final int n=i;
                results.add(pool.submit(()->{
                    try {
                        as(actor,()->submissions.submit(meeting,
                                ExportFormat.MARKDOWN,"quota-parallel-"+n,source));
                        return true;
                    } catch (org.springframework.web.server.ResponseStatusException ex) {
                        assertThat(ex.getStatusCode().value()).isEqualTo(429);
                        return false;
                    }
                }));
            }
            int successes=0;
            for(var f:results) if(f.get(60,java.util.concurrent.TimeUnit.SECONDS)) successes++;
            assertThat(successes).isEqualTo(5);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM meeting_exports WHERE meeting_id=?
                """,Long.class,meeting)).isEqualTo(5L);
        } finally {
            pool.shutdownNow();
        }
    }

    private MinutesSnapshot snapshot(UUID meetingId, UUID actor, String summaryText) {
        OffsetDateTime now=OffsetDateTime.parse("2026-11-07T12:00:00Z");
        var meeting = new MinutesSnapshot.Meeting(meetingId,"Biên bản thử",null,
                actor, MeetingStatus.DRAFT,null,null,null,null);
        UUID transcriptId=UUID.randomUUID();
        var summary=new MinutesSnapshot.Summary("AVAILABLE",UUID.randomUUID(),1,
                summaryText,"HUMAN_EDIT","READY",transcriptId,1L,1L,false,List.of());
        var transcript=new MinutesSnapshot.Transcript("AVAILABLE",transcriptId,
                UUID.randomUUID(),1,"vi","READY",1L,60000L,0,0,0);
        var canonical=new MinutesSnapshot.CanonicalContent(1,"COMPLETE",meeting,
                summary,List.of(),List.of(),transcript,List.of(),false);
        try {
            String hash=ExportSnapshotCodec.sha256(json.writeValueAsBytes(canonical));
            return new MinutesSnapshot(1,now,hash,"COMPLETE",meeting,
                    summary,List.of(),List.of(),transcript,List.of(),false);
        } catch (tools.jackson.core.JacksonException e) {
            throw new IllegalStateException(e);
        }
    }

    private UUID user() {
        UUID id=UUID.randomUUID();
        String email="de09-"+id+"@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,
                              global_role,account_status)
            VALUES(?,?,?,'DE09 actor','test-only','EMPLOYEE','ACTIVE')
            """,id,email,email);
        return id;
    }

    private UUID meeting(UUID actor) {
        UUID id=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id,status)
            VALUES(?,'DE09 fixture',?,?,'DRAFT')
            """,id,actor,actor);
        return id;
    }

    private static <T> T as(UUID actor, Supplier<T> op) {
        RequestAttributes old=RequestContextHolder.getRequestAttributes();
        MockHttpServletRequest request=new MockHttpServletRequest();
        Principal principal=()->actor.toString();
        request.setUserPrincipal(principal);
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        try { return op.get(); }
        finally {
            if(old==null) RequestContextHolder.resetRequestAttributes();
            else RequestContextHolder.setRequestAttributes(old);
        }
    }
}
