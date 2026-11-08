package com.sme.meetingassistant.api.media.diarization;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.meetingexport.ExportArtifactStore;
import com.sme.meetingassistant.api.meetingexport.ExportDownloadStore;
import com.sme.meetingassistant.api.meetingexport.ExportSnapshotCodec;
import com.sme.meetingassistant.api.meetingexport.ExportJobProcessor;
import com.sme.meetingassistant.api.meetingexport.ExportRecord;
import com.sme.meetingassistant.api.meetingexport.ExportStatus;
import com.sme.meetingassistant.api.meetingexport.MeetingExportRepository;
import com.sme.meetingassistant.api.meetingminutes.MinutesAssembler;
import com.sme.meetingassistant.api.meeting.service.MeetingReportingPort;
import com.sme.meetingassistant.api.dashboard.query.DashboardReportingQueries;
import com.sme.meetingassistant.api.media.service.ProcessingReportingPort;
import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository;
import com.sme.meetingassistant.api.transcript.service.SqlTranscriptMinutesReader;
import com.sme.meetingassistant.api.transcript.service.TranscriptMinutesSource;
import java.nio.charset.StandardCharsets;
import java.security.Principal;
import java.time.Instant;
import java.util.Arrays;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Task 03: real PostgreSQL V43, real Diarization worker acceptance and canonical
 * speaker projection, real Minutes/Reporting/Export persistence and both renderers.
 *
 * Only S3 bytes and the browser-facing signing origin are isolated: the former
 * is an integrity-verifying immutable store; real SDK semantics are independently
 * covered by ExportS3StorageIntegrationTests. No canonical source is mocked.
 */
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "app.exports.public-admission-enabled=true",
        "app.exports.worker.enabled=true",
        "app.exports.worker.poll-delay-ms=3600000",
        "app.exports.reconciliation.enabled=false",
        "app.exports.reconciliation.purge-enabled=false"
})
@Import(DiarizationDashboardExportConsistencyIntegrationTests.ExportStoreConfig.class)
class DiarizationDashboardExportConsistencyIntegrationTests
        extends DiarizationIntegrationFixture {
    /** Test-only S3 isolation; real PostgreSQL, worker and canonical adapters remain installed. */
    static final class VerifiedPrivateStore implements ExportArtifactStore {
        private final java.util.Map<String, byte[]> objects = new java.util.concurrent.ConcurrentHashMap<>();

        @Override
        public void putVerified(String key, byte[] bytes, String contentType, String sha256) {
            if (bytes == null || bytes.length == 0
                    || bytes.length > 32 * 1024 * 1024
                    || !ExportSnapshotCodec.sha256(bytes).equals(sha256)) {
                throw new IntegrityFailure("Invalid private export digest");
            }
            byte[] prior = objects.putIfAbsent(key, bytes.clone());
            if (prior != null && !Arrays.equals(prior, bytes)) {
                throw new IntegrityFailure("Immutable private object key collision");
            }
        }

        @Override
        public byte[] readVerified(String key, String sha256, int maximum) {
            byte[] bytes = objects.get(key);
            if (bytes == null) {
                throw new StorageFailure("Missing private bytes", new IllegalStateException());
            }
            if (maximum < 1 || maximum > 32 * 1024 * 1024
                    || bytes.length > maximum
                    || !ExportSnapshotCodec.sha256(bytes).equals(sha256)) {
                throw new IntegrityFailure("Private export checksum mismatch");
            }
            return bytes.clone();
        }

        void clear() { objects.clear(); }
    }

    /**
     * Deterministic mid-read barrier: suspend only after Transcript's SQL has
     * established the Minutes REPEATABLE_READ snapshot; let the real writer
     * commit on another connection before Summary/Decision SQL executes.
     */
    static final class CoordinatedTranscriptReader implements TranscriptMinutesSource {
        private final SqlTranscriptMinutesReader delegate;
        private volatile Gate pending;

        record Gate(UUID meetingId, java.util.concurrent.CountDownLatch captured,
                java.util.concurrent.CountDownLatch resume) {
            void release() { resume.countDown(); }
        }

        CoordinatedTranscriptReader(SqlTranscriptMinutesReader delegate) {
            this.delegate = delegate;
        }

        Gate arm(UUID meetingId) {
            Gate gate = new Gate(meetingId,
                    new java.util.concurrent.CountDownLatch(1),
                    new java.util.concurrent.CountDownLatch(1));
            if (pending != null) throw new IllegalStateException("Already armed");
            pending = gate;
            return gate;
        }

        void release() {
            Gate gate = pending;
            if (gate != null) {
                gate.release();
                pending = null;
            }
        }

        @Override
        public java.util.Optional<Reference> currentReference(UUID meetingId) {
            var value = delegate.currentReference(meetingId);
            Gate gate = pending;
            if (gate != null && gate.meetingId().equals(meetingId)) {
                gate.captured().countDown();
                try {
                    if (!gate.resume().await(20, java.util.concurrent.TimeUnit.SECONDS)) {
                        throw new IllegalStateException("Timed out coordinating canonical snapshot");
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException("Canonical snapshot interrupted", interrupted);
                } finally {
                    if (pending == gate) pending = null;
                }
            }
            return value;
        }
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class ExportStoreConfig {
        @Bean
        @Primary
        CoordinatedTranscriptReader task03TranscriptReader(SqlTranscriptMinutesReader delegate) {
            return new CoordinatedTranscriptReader(delegate);
        }

        @Bean
        @Primary
        VerifiedPrivateStore task03ImmutableStore() {
            return new VerifiedPrivateStore();
        }

        @Bean
        @Primary
        ExportDownloadStore task03DownloadStore(
                VerifiedPrivateStore store) {
            return (record, ttl) -> {
                if (record.status() != ExportStatus.READY) {
                    throw new ExportArtifactStore.IntegrityFailure("Non-ready export");
                }
                byte[] bytes = store.readVerified(record.objectKey(),
                        record.artifactSha256(), 32 * 1024 * 1024);
                if (record.artifactSizeBytes() == null
                        || bytes.length != record.artifactSizeBytes()) {
                    throw new ExportArtifactStore.IntegrityFailure("Export bytes changed");
                }
                return "https://downloads.example.invalid/task03/" + record.id()
                        + "?X-Amz-Signature=integrity-verified";
            };
        }
    }

    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired ExportJobProcessor exportsWorker;
    @Autowired MeetingExportRepository records;
    @Autowired VerifiedPrivateStore artifactStore;
    @Autowired DashboardReportingQueries dashboard;
    @Autowired ProcessingReportingPort technicalJobs;
    @Autowired MinutesAssembler assembler;
    @Autowired TranscriptRepository transcriptRepository;
    @Autowired CoordinatedTranscriptReader interleaver;
    @Autowired TransactionTemplate transaction;

    private UUID member;
    private UUID outsider;
    private UUID action;
    private UUID summaryId;

    @BeforeEach
    void canonicalBusinessSources() {
        artifactStore.clear();
        member = newUser("EMPLOYEE");
        outsider = newUser("ADMINISTRATOR");
        jdbc.update("INSERT INTO meeting_participants(id,meeting_id,user_id) VALUES (?,?,?)",
                UUID.randomUUID(), meeting, member);

        UUID summaryStage = UUID.randomUUID(), snapshot = UUID.randomUUID(),
                receipt = UUID.randomUUID();
        summaryId = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'GENERATING_SUMMARY',1,'SUCCEEDED')
            """, summaryStage, job);
        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(
                id,meeting_id,source_media_id,processing_job_id,transcript_id,
                content_revision,sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,0,?,?,128)
            """, snapshot, meeting, media, job, transcript, "a".repeat(64),
                "processing/" + job + "/intelligence/source/" + snapshot + ".json");
        jdbc.update("""
            INSERT INTO meeting_intelligence_result_receipts(
                id,meeting_id,processing_job_id,stage_run_id,result_type,
                source_snapshot_id,transcript_id,content_revision,artifact_sha256,
                artifact_object_key,artifact_size_bytes)
            VALUES (?,?,?,?,'SUMMARY',?,?,0,?,?,128)
            """, receipt, meeting, job, summaryStage, snapshot, transcript, "b".repeat(64),
                "processing/" + job + "/intelligence/results/" + summaryStage + ".json");
        jdbc.update("""
            INSERT INTO meeting_summary_versions(
                id,meeting_id,version_number,content,source_type,processing_job_id,
                result_receipt_id,transcript_id,content_revision,quality_status,is_current)
            VALUES (?,?,1,'Tóm tắt đã kiểm duyệt','AI_GENERATED',?,?,?,0,'READY',TRUE)
            """, summaryId, meeting, job, receipt, transcript);
        jdbc.update("""
            INSERT INTO meeting_decisions(id,meeting_id,content,status,source_type,
                created_by_user_id,confirmed_by_user_id,confirmed_at)
            VALUES (?,?,'Quyết định triển khai','CONFIRMED','MANUAL',?,?,CURRENT_TIMESTAMP)
            """, UUID.randomUUID(), meeting, actor, actor);
        action = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO action_items(id,meeting_id,title,status,assignee_user_id,
                source_type,created_by_user_id)
            VALUES (?,?,?,'OPEN',?,'MANUAL',?)
            """, action, meeting, "Kiểm tra chất lượng", member, actor);
    }

    @Test
    void acceptedSpeakerProjectionInvalidatesBothReadyExportsWithoutMutatingHistory()
            throws Exception {
        JsonNode originalMinutes = minutes(actor);
        assertThat(originalMinutes.path("completeness").asText()).isEqualTo("COMPLETE");
        assertThat(originalMinutes.path("summary").path("isStale").asBoolean()).isFalse();
        String originalFingerprint = originalMinutes.path("sourceFingerprint").asText();
        assertThat(originalFingerprint).matches("[0-9a-f]{64}");

        UUID markdown = requestExport("MARKDOWN", "task03-md", actor);
        UUID pdf = requestExport("PDF", "task03-pdf", actor);
        assertThat(exportsWorker.processNext()).isTrue();
        assertThat(exportsWorker.processNext()).isTrue();
        ExportRecord md = records.require(markdown), pd = records.require(pdf);
        assertThat(md.status()).isEqualTo(ExportStatus.READY);
        assertThat(pd.status()).isEqualTo(ExportStatus.READY);
        assertThat(md.sourceFingerprint()).isEqualTo(originalFingerprint);
        assertThat(pd.sourceFingerprint()).isEqualTo(originalFingerprint);
        byte[] mdBytes = artifactStore.readVerified(md.objectKey(), md.artifactSha256(), 32 * 1024 * 1024);
        byte[] pdfBytes = artifactStore.readVerified(pd.objectKey(), pd.artifactSha256(), 32 * 1024 * 1024);
        assertThat(new String(mdBytes, StandardCharsets.UTF_8))
                .contains("Tóm tắt đã kiểm duyệt", "Quyết định triển khai", "Kiểm tra chất lượng");
        assertThat(exportStatus(markdown, member).path("freshness").asText())
                .isEqualTo("CURRENT");
        assertThat(exportStatus(pdf, member).path("freshness").asText())
                .isEqualTo("CURRENT");

        var before = dashboard(actor);
        assertThat(before.visibleMeetingStates().get(
                com.sme.meetingassistant.api.meeting.entity.MeetingStatus.DRAFT)).isEqualTo(1L);
        assertThat(before.visibleTechnicalJobStates()).containsEntry("RUNNING", 1L);

        claim();
        var accepted = upload(artifact());
        assertThat(completion.complete(job, accepted).get("state")).isEqualTo("RESULT_ACCEPTED");
        assertThat(revision()).isEqualTo(1L);
        assertThat(stageStatus()).isEqualTo("SUCCEEDED");
        assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM speaker_clusters WHERE transcript_id=?", Long.class,
                transcript)).isEqualTo(1L);
        assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM diarization_acceptance_measurements WHERE processing_job_id=?",
                Long.class, job)).isEqualTo(1L);

        JsonNode after = minutes(actor);
        assertThat(after.path("completeness").asText()).isEqualTo("NEEDS_REVIEW");
        assertThat(after.path("summary").path("isStale").asBoolean()).isTrue();
        assertThat(after.path("warnings").toString()).contains("SUMMARY_SOURCE_STALE");
        assertThat(after.path("sourceFingerprint").asText()).isNotEqualTo(originalFingerprint);
        assertThat(exportStatus(markdown, member).path("freshness").asText())
                .isEqualTo("STALE");
        assertThat(exportStatus(pdf, member).path("freshness").asText())
                .isEqualTo("STALE");

        // Original immutable bytes remain downloadable (with STALE evidence).
        assertThat(artifactStore.readVerified(md.objectKey(), md.artifactSha256(),
                32 * 1024 * 1024)).isEqualTo(mdBytes);
        assertThat(artifactStore.readVerified(pd.objectKey(), pd.artifactSha256(),
                32 * 1024 * 1024)).isEqualTo(pdfBytes);
        JsonNode issued = data(mvc.perform(post("/api/v1/exports/{id}/access-url", markdown)
                .principal(as(member))).andExpect(status().isOk()).andReturn());
        assertThat(issued.path("freshness").asText()).isEqualTo("STALE");
        assertThat(issued.path("accessUrl").asText()).startsWith("https://");

        // Do not create a fresh official export from a now-stale AI summary.
        mvc.perform(post("/api/v1/meetings/{id}/exports", meeting)
                .principal(as(actor)).header("Idempotency-Key", "task03-new")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"format\":\"PDF\"}")).andExpect(status().isConflict());
        // Idempotent historical replay is still valid but cannot replace original intake.
        assertThat(requestExport("MARKDOWN", "task03-md", actor)).isEqualTo(markdown);
        assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM meeting_exports WHERE meeting_id=?", Long.class,
                meeting)).isEqualTo(2L);
        assertThat(records.require(markdown).sourceFingerprint()).isEqualTo(originalFingerprint);
        assertThat(records.require(pdf).status()).isEqualTo(ExportStatus.READY);

        var afterDashboard = dashboard(actor);
        assertThat(afterDashboard.visibleMeetingStates()).isEqualTo(before.visibleMeetingStates());
        assertThat(afterDashboard.visibleTechnicalJobStates()).containsEntry("COMPLETED", 1L)
                .doesNotContainKey("RUNNING");
        assertThat(jdbc.queryForObject("SELECT status FROM meetings WHERE id=?", String.class, meeting))
                .isEqualTo("DRAFT");

        // Accepted completion replay after human correction is read-only and
        // cannot project a second speaker mapping or rewrite the historical PDF.
        UUID segment = jdbc.queryForObject(
                "SELECT id FROM transcript_segments WHERE transcript_id=? AND ordinal=7",
                UUID.class, transcript);
        transaction.executeWithoutResult(tx -> transcriptRepository.correct(
                meeting, segment, actor, "Nội dung đã chỉnh sửa", "Reviewed", 1));
        assertThat(revision()).isEqualTo(2L);
        assertThat(completion.complete(job, accepted).get("state")).isEqualTo("RESULT_ACCEPTED");
        assertThat(revision()).isEqualTo(2L);
        assertThat(exportStatus(markdown, actor).path("freshness").asText())
                .isEqualTo("STALE");
        assertThat(artifactStore.readVerified(pd.objectKey(), pd.artifactSha256(),
                32 * 1024 * 1024)).isEqualTo(pdfBytes);

        // An ADMINISTRATOR without membership is not a content reader.
        mvc.perform(get("/api/v1/exports/{id}", markdown)
                .principal(as(outsider))).andExpect(status().isNotFound());
        mvc.perform(post("/api/v1/exports/{id}/access-url", markdown)
                .principal(as(outsider))).andExpect(status().isNotFound());
        jdbc.update("""
            UPDATE meeting_participants SET removed_at=clock_timestamp()
            WHERE meeting_id=? AND user_id=? AND removed_at IS NULL
            """, meeting, member);
        mvc.perform(get("/api/v1/exports/{id}", markdown)
                .principal(as(member))).andExpect(status().isNotFound());
        mvc.perform(post("/api/v1/exports/{id}/access-url", markdown)
                .principal(as(member))).andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/meetings/{id}/minutes", meeting)
                .principal(as(member))).andExpect(status().isNotFound());
    }

    @Test
    void concurrentDiarizationCommitCannotMixTranscriptAndSummaryFromDifferentSnapshots()
            throws Exception {
        String originalFingerprint = minutes(actor).path("sourceFingerprint").asText();
        var gate = interleaver.arm(meeting);
        var pool = java.util.concurrent.Executors.newSingleThreadExecutor();
        try {
            // In a real REPEATABLE_READ transaction, the Transcript SELECT
            // establishes a snapshot before Diarization's writer commits.
            var pendingMinutes = pool.submit(() ->
                    withActor(actor, () -> assembler.current(meeting)));
            assertThat(gate.captured().await(20, java.util.concurrent.TimeUnit.SECONDS))
                    .describedAs("Transcript SQL must finish before the Diarization writer starts")
                    .isTrue();

            claim();
            var completed = upload(artifact());
            assertThat(completion.complete(job, completed).get("state"))
                    .isEqualTo("RESULT_ACCEPTED");
            assertThat(revision()).isEqualTo(1L);
            gate.release();

            var consistent = pendingMinutes.get(20, java.util.concurrent.TimeUnit.SECONDS);
            assertThat(consistent.transcript().contentRevision()).isZero();
            assertThat(consistent.summary().isStale()).isFalse();
            assertThat(consistent.sourceFingerprint()).isEqualTo(originalFingerprint);
            assertThat(consistent.completeness()).isEqualTo("COMPLETE");

            // A subsequent request takes a fresh snapshot and observes both
            // the new canonical transcript revision and stale Summary lineage.
            var updated = minutes(actor);
            assertThat(updated.path("transcript").path("contentRevision").asLong()).isEqualTo(1L);
            assertThat(updated.path("summary").path("isStale").asBoolean()).isTrue();
            assertThat(updated.path("completeness").asText()).isEqualTo("NEEDS_REVIEW");
            assertThat(updated.path("sourceFingerprint").asText())
                    .isNotEqualTo(originalFingerprint);
        } finally {
            interleaver.release();
            pool.shutdownNow();
        }
    }

    @Test
    void optionalDiarizationFailurePreservesReadyExportAndDoesNotCountAsFailedMeeting()
            throws Exception {
        String fingerprint = minutes(actor).path("sourceFingerprint").asText();
        UUID export = requestExport("MARKDOWN", "task03-warnings", actor);
        assertThat(exportsWorker.processNext()).isTrue();
        assertThat(records.require(export).status()).isEqualTo(ExportStatus.READY);
        assertThat(exportStatus(export, member).path("freshness").asText())
                .isEqualTo("CURRENT");

        claim();
        var failed = new DiarizationCommands.Fail(UUID.randomUUID(), owner,
                "INFERENCE", "TIMEOUT");
        assertThat(worker.fail(job, failed).get("state")).isEqualTo("FAILURE_RECORDED");
        assertThat(worker.fail(job, failed).get("state")).isEqualTo("FAILURE_RECORDED");
        assertThat(revision()).isZero();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM speaker_clusters WHERE transcript_id=?",
                Long.class, transcript)).isZero();
        assertThat(minutes(actor).path("sourceFingerprint").asText())
                .isEqualTo(fingerprint);
        assertThat(exportStatus(export, member).path("freshness").asText())
                .isEqualTo("CURRENT");
        assertThat(records.require(export).status()).isEqualTo(ExportStatus.READY);
        assertThat(dashboard(actor).visibleTechnicalJobStates())
                .containsEntry("COMPLETED_WITH_WARNINGS", 1L);
        assertThat(dashboard(actor).visibleMeetingStates().get(
                com.sme.meetingassistant.api.meeting.entity.MeetingStatus.DRAFT))
                .isEqualTo(1L);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM diarization_worker_receipts"
                + " WHERE processing_job_id=?", Long.class, job)).isEqualTo(1L);
    }

    private UUID requestExport(String format, String key, UUID who) throws Exception {
        var result = mvc.perform(post("/api/v1/meetings/{id}/exports", meeting)
                .principal(as(who)).header("Idempotency-Key", key)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"format\":\"" + format + "\"}"))
                .andExpect(status().isAccepted()).andReturn();
        return UUID.fromString(data(result).path("exportId").asText());
    }

    private JsonNode minutes(UUID who) throws Exception {
        return data(mvc.perform(get("/api/v1/meetings/{id}/minutes", meeting)
                .principal(as(who))).andExpect(status().isOk()).andReturn());
    }

    private JsonNode exportStatus(UUID id, UUID who) throws Exception {
        return data(mvc.perform(get("/api/v1/exports/{id}", id)
                .principal(as(who))).andExpect(status().isOk()).andReturn());
    }

    private DashboardReportingQueries.AuthorizedProjection dashboard(UUID who) {
        var asOf = Instant.parse("2026-11-08T03:00:00Z");
        return withActor(who, () -> dashboard.currentVisible(who, asOf,
                new DashboardReportingQueries.Window(asOf, asOf.plusSeconds(86400), 10),
                new DashboardReportingQueries.Window(asOf.minusSeconds(86400), asOf, 10)));
    }

    private long revision() {
        return jdbc.queryForObject("SELECT content_revision FROM transcripts WHERE id=?",
                Long.class, transcript);
    }

    private UUID newUser(String role) {
        UUID id = UUID.randomUUID();
        String email = "task03-" + id + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,
                global_role,account_status)
            VALUES (?,?,?,'Task 03','test-only',?,'ACTIVE')
            """, id, email, email, role);
        return id;
    }

    private static Principal as(UUID actor) { return () -> actor.toString(); }

    private static <T> T withActor(UUID who, java.util.function.Supplier<T> operation) {
        org.springframework.web.context.request.RequestAttributes previous =
                org.springframework.web.context.request.RequestContextHolder.getRequestAttributes();
        var request = new org.springframework.mock.web.MockHttpServletRequest();
        request.setUserPrincipal(as(who));
        org.springframework.web.context.request.RequestContextHolder.setRequestAttributes(
                new org.springframework.web.context.request.ServletRequestAttributes(request));
        try { return operation.get(); }
        finally {
            if (previous == null) {
                org.springframework.web.context.request.RequestContextHolder.resetRequestAttributes();
            } else {
                org.springframework.web.context.request.RequestContextHolder.setRequestAttributes(previous);
            }
        }
    }

    private JsonNode data(MvcResult result) throws Exception {
        JsonNode payload = json.readTree(result.getResponse().getContentAsString());
        assertThat(payload.path("success").asBoolean()).isTrue();
        return payload.path("data");
    }
}
