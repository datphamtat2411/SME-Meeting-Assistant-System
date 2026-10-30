package com.sme.meetingassistant.api.transcript;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.CoverageResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.SegmentResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.SpeakerResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.TranscriptResult;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.web.server.ResponseStatusException;

@ActiveProfiles("test")
@SpringBootTest(properties = "app.media.outbox.enabled=false")
@Import(PostgresTestConfiguration.class)
class TranscriptPublicationIdempotencyIntegrationTests {
    @Autowired TranscriptIngestion ingestion;
    @Autowired JdbcTemplate jdbc;

    private UUID actor, meeting, media, job, finalization;

    @BeforeEach
    void setup() {
        actor = UUID.randomUUID();
        meeting = UUID.randomUUID();
        media = UUID.randomUUID();
        String email = "tr01-" + actor + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Transcript publication test','test-only','EMPLOYEE','ACTIVE')
            """, actor, email, email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Transcript publication',?,?)
            """, meeting, actor, actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
              content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,10000,?,CURRENT_TIMESTAMP)
            """, media, meeting, "meetings/" + meeting + "/sources/" + media,
            "meetings/" + meeting + "/pending/" + media, actor);
        var first = completedJob();
        job = first.job();
        finalization = first.stage();
    }

    private record Source(UUID job, UUID stage) { }

    private Source completedJob() {
        UUID newJob = UUID.randomUUID(), newStage = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,
                status,reprocess_of_job_id)
            VALUES (?,?,?,?,'COMPLETED',?)
            """, newJob, meeting, media, actor, job);
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'FINALIZING_TRANSCRIPT',1,'SUCCEEDED')
            """, newStage, newJob);
        return new Source(newJob, newStage);
    }

    private TranscriptResult result(UUID jobId, UUID stage, String text) {
        return new TranscriptResult(meeting, media, jobId, stage, "vi", 10000L,
            TranscriptIngestion.Status.READY,
            List.of(new SegmentResult(0, 100, 1200, text, "ACCEPTED", "Speaker 1",
                stage, Map.of("confidence", 0.97))),
            List.of(new CoverageResult(100, 1200, "COVERED", false, 0, Map.of("accepted", true))),
            List.of(new SpeakerResult("Speaker 1")));
    }

    private TranscriptResult result(String text) { return result(job, finalization, text); }

    private int versions() {
        return jdbc.queryForObject("SELECT count(*) FROM transcripts WHERE meeting_id=?",
            Integer.class, meeting);
    }

    private UUID current() {
        return jdbc.queryForObject("SELECT id FROM transcripts WHERE meeting_id=? AND is_current",
            UUID.class, meeting);
    }

    private static void assertConflict(Runnable action) {
        assertThatThrownBy(action::run).isInstanceOf(ResponseStatusException.class)
            .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT));
    }

    @Test
    void identicalRedeliveryDoesNotCreateVersionsSegmentsOrSpeakerClusters() {
        TranscriptResult r = result("Nội dung đã được LLM hiệu chỉnh.");
        ingestion.publish(r);
        UUID accepted = current();
        ingestion.publish(r);
        assertThat(current()).isEqualTo(accepted);
        assertThat(versions()).isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM transcript_segments WHERE transcript_id=?", Integer.class, accepted))
            .isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM speaker_clusters WHERE transcript_id=?", Integer.class, accepted))
            .isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM transcript_coverage_regions WHERE transcript_id=?", Integer.class, accepted))
            .isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT publication_sha256 FROM transcripts WHERE id=?", String.class, accepted))
            .matches("[0-9a-f]{64}");
    }

    @Test
    void sameJobDifferentTextIsRejectedWithoutMutatingCanonicalVersion() {
        ingestion.publish(result("Bản kết quả đầu."));
        UUID accepted = current();
        assertConflict(() -> ingestion.publish(result("Bản kết quả đã thay đổi.")));
        assertThat(versions()).isEqualTo(1);
        assertThat(current()).isEqualTo(accepted);
    }

    @Test
    void replayAfterHumanCorrectionDoesNotOverwriteHumanText() {
        TranscriptResult original = result("Lời AI ban đầu.");
        ingestion.publish(original);
        UUID accepted = current();
        jdbc.update("""
            UPDATE transcript_segments SET current_text='Nội dung người dùng đã sửa.',
                version=version+1 WHERE transcript_id=?
            """, accepted);
        ingestion.publish(original);
        assertThat(jdbc.queryForObject(
            "SELECT current_text FROM transcript_segments WHERE transcript_id=?",
            String.class, accepted)).isEqualTo("Nội dung người dùng đã sửa.");
        assertThat(versions()).isEqualTo(1);
    }

    @Test
    void fingerprintIsInsensitiveToNestedMetadataMapOrdering() {
        Map<String, Object> one = new LinkedHashMap<>();
        one.put("z", Map.of("b", 2, "a", 1));
        one.put("a", 0.97);
        Map<String, Object> two = new LinkedHashMap<>();
        two.put("a", 0.97);
        Map<String, Object> nested = new LinkedHashMap<>();
        nested.put("a", 1); nested.put("b", 2);
        two.put("z", nested);
        TranscriptResult initial = result("Bản hiệu chỉnh.");
        TranscriptResult first = new TranscriptResult(initial.meetingId(), initial.sourceMediaId(),
            initial.processingJobId(), initial.sourceStageRunId(), initial.languageCode(), initial.durationMs(),
            initial.status(), List.of(new SegmentResult(0, 100, 1200, "Bản hiệu chỉnh.",
                "ACCEPTED", "Speaker 1", finalization, one)),
            initial.coverage(), initial.speakers());
        TranscriptResult second = new TranscriptResult(initial.meetingId(), initial.sourceMediaId(),
            initial.processingJobId(), initial.sourceStageRunId(), initial.languageCode(), initial.durationMs(),
            initial.status(), List.of(new SegmentResult(0, 100, 1200, "Bản hiệu chỉnh.",
                "ACCEPTED", "Speaker 1", finalization, two)),
            initial.coverage(), initial.speakers());
        ingestion.publish(first);
        ingestion.publish(second);
        assertThat(versions()).isEqualTo(1);
    }

    @Test
    void invalidFinalizationOrForeignJobStageDoesNotPublish() {
        UUID unrelatedStage = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'TRANSCRIPTION',1,'SUCCEEDED')
            """, unrelatedStage, job);
        assertConflict(() -> ingestion.publish(result(job, unrelatedStage, "Wrong stage.")));
        var other = completedJob();
        assertConflict(() -> ingestion.publish(result(job, other.stage(), "Wrong job.")));
        assertThatThrownBy(() -> ingestion.publish(result(job, null, "Missing provenance.")))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY));
        assertThat(versions()).isZero();
    }

    @Test
    void staleFinalizationAttemptCannotPublish() {
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'FINALIZING_TRANSCRIPT',2,'SUCCEEDED')
            """, UUID.randomUUID(), job);
        assertConflict(() -> ingestion.publish(result("Old attempt.")));
        assertThat(versions()).isZero();
    }

    @Test
    void concurrentDuplicateDeliveriesCommitOneCanonicalVersion() throws Exception {
        TranscriptResult result = result("Bản được công bố một lần.");
        try (var workers = Executors.newFixedThreadPool(2)) {
            var gate = new CountDownLatch(1);
            var first = workers.submit(() -> { gate.await(); ingestion.publish(result); return true; });
            var second = workers.submit(() -> { gate.await(); ingestion.publish(result); return true; });
            gate.countDown();
            assertThat(first.get(20, TimeUnit.SECONDS)).isTrue();
            assertThat(second.get(20, TimeUnit.SECONDS)).isTrue();
        }
        assertThat(versions()).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT version_number FROM transcripts WHERE meeting_id=?",
            Integer.class, meeting)).isEqualTo(1);
    }

    @Test
    void competingDifferentResultsCannotBothBecomeCanonical() throws Exception {
        try (var workers = Executors.newFixedThreadPool(2)) {
            var gate = new CountDownLatch(1);
            var first = workers.submit(() -> {
                gate.await();
                ingestion.publish(result("Candidate A."));
                return true;
            });
            var second = workers.submit(() -> {
                gate.await();
                ingestion.publish(result("Candidate B."));
                return true;
            });
            gate.countDown();
            int accepted = 0, rejected = 0;
            for (var task : List.of(first, second)) {
                try {
                    assertThat(task.get(20, TimeUnit.SECONDS)).isTrue();
                    accepted++;
                } catch (ExecutionException error) {
                    assertThat(error.getCause()).isInstanceOf(ResponseStatusException.class);
                    assertThat(((ResponseStatusException) error.getCause()).getStatusCode())
                        .isEqualTo(HttpStatus.CONFLICT);
                    rejected++;
                }
            }
            assertThat(accepted).isEqualTo(1);
            assertThat(rejected).isEqualTo(1);
        }
        assertThat(versions()).isEqualTo(1);
    }

    @Test
    void failedInsertRollsBackPromotionAndKeepsPreviousCurrentVersion() {
        ingestion.publish(result("First canonical result."));
        UUID existing = current();
        Source next = completedJob();
        TranscriptResult malformed = new TranscriptResult(meeting, media, next.job(), next.stage(),
            "vi", 10000L, TranscriptIngestion.Status.READY,
            List.of(
                new SegmentResult(0, 100, 500, "First.", "ACCEPTED", null, next.stage(), null),
                new SegmentResult(0, 500, 900, "Duplicate ordinal.", "ACCEPTED", null, next.stage(), null)),
            List.of(new CoverageResult(0, 900, "COVERED", false, 0, null)), List.of());
        assertThatThrownBy(() -> ingestion.publish(malformed))
            .isInstanceOf(DataIntegrityViolationException.class);
        assertThat(current()).isEqualTo(existing);
        assertThat(versions()).isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT is_current FROM transcripts WHERE id=?", Boolean.class, existing)).isTrue();
    }
}
