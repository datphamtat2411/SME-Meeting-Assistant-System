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
    @Autowired ExportGenerationStateMachine state;
    @Autowired MeetingExportRepository records;
    @Autowired InMemoryExportStore storage;

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
    void idempotentReplayRetainsOriginalVerifiedSourceNotLatestChangedMeeting() {
        UUID owner=user(), meeting=meeting(owner);
        MinutesSnapshot original=snapshot(meeting,owner,"Nội dung gốc");
        MinutesSnapshot changed=snapshot(meeting,owner,"Nội dung đã thay đổi");
        ExportRecord first=as(owner, () -> submissions.submit(meeting,
                ExportFormat.MARKDOWN,"same-retry-key",original));
        ExportRecord replay=as(owner, () -> submissions.submit(meeting,
                ExportFormat.MARKDOWN,"same-retry-key",changed));
        assertThat(replay.id()).isEqualTo(first.id());
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
        assertThat(failed.readyAt()).isNull();
        assertThat(failed.objectKey()).isNull();

        storage.failArtifact=false;
        Thread.sleep(1150);
        worker.reconcile();
        assertThat(records.require(pending.id()).status()).isEqualTo(ExportStatus.PENDING);
        assertThat(worker.processNext()).isTrue();
        ExportRecord ready=records.require(pending.id());
        assertThat(ready.status()).isEqualTo(ExportStatus.READY);
        assertThat(ready.generationAttempt()).isEqualTo(2);
        assertThat(ready.claimToken()).isNull();
        assertThat(ready.snapshotObjectKey()).isNotNull();
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
        worker.reconcile();
        assertThat(records.require(pending.id()).status()).isEqualTo(ExportStatus.FAILED);
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
