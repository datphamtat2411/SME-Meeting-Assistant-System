package com.sme.meetingassistant.api.transcript;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.media.repository.MediaRepository.ProcessingLifecycleConflictException;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.support.CorrectedTranscriptFixture;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.integration.TranscriptFinalizationService;
import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository;
import com.sme.meetingassistant.api.transcript.service.TranscriptReviewService;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.CoverageResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.SegmentResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.SpeakerResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.TranscriptResult;
import java.util.List;
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
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

@ActiveProfiles("test")
@SpringBootTest(properties = {
    "app.media.outbox.enabled=false",
    "app.media.processing.stage-lease-sweep-ms=3600000"
})
@Import(PostgresTestConfiguration.class)
class TranscriptFinalizationIntegrationTests {
    @Autowired ProcessingJobLifecycle lifecycle;
    @Autowired TranscriptFinalizationService finalization;
    @Autowired TranscriptRepository transcripts;
    @Autowired TranscriptReviewService review;
    @Autowired TransactionTemplate transactions;
    @Autowired JdbcTemplate jdbc;

    private UUID meeting;
    private UUID media;
    private UUID job;
    private StageClaim transcription;
    private StageClaim finalizer;

    @BeforeEach
    void setUp() {
        UUID actor = UUID.randomUUID();
        meeting = UUID.randomUUID();
        media = UUID.randomUUID();
        job = UUID.randomUUID();
        String email = "int01-" + actor + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'INT01 test','test-only','EMPLOYEE','ACTIVE')
            """, actor, email, email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Atomic transcript finalization',?,?)
            """, meeting, actor, actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',1024,1024,10000,?,CURRENT_TIMESTAMP)
            """, media, meeting, "meetings/" + meeting + "/sources/" + media,
            "meetings/" + meeting + "/pending/" + media, actor);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status,queued_at)
            VALUES (?,?,?,?,'QUEUED',CURRENT_TIMESTAMP)
            """, job, meeting, media, actor);
        transcription = lifecycle.startStage(job, "TRANSCRIPTION", "whisper", "base");
        lifecycle.completeStage(transcription, "SUCCEEDED", null, "{\"speech_coverage_validated\":true}");
        finalizer = lifecycle.startStage(job, "FINALIZING_TRANSCRIPT", "llm", "corrected");
    }

    private TranscriptResult result(String text) {
        return makeResult(text, TranscriptIngestion.Status.READY, "ACCEPTED", "COVERED");
    }

    private TranscriptResult makeResult(String text, TranscriptIngestion.Status status,
            String quality, String coverageStatus) {
        TranscriptResult verified = new TranscriptResult(meeting, media, job, finalizer.stageRunId(), "vi",
            10_000L, status,
            List.of(new SegmentResult(0, 100, 1250, text, quality, null,
                finalizer.stageRunId(), null)),
            List.of(new CoverageResult(100, 1250, coverageStatus, false, 0, null)),
            List.of());
        CorrectedTranscriptFixture.record(jdbc, verified);
        return verified;
    }

    private String jobStatus() {
        return jdbc.queryForObject("SELECT status FROM processing_jobs WHERE id=?",
            String.class, job);
    }

    private String finalStageStatus() {
        return jdbc.queryForObject("SELECT status FROM processing_stage_runs WHERE id=?",
            String.class, finalizer.stageRunId());
    }

    private int transcriptCount() {
        return jdbc.queryForObject("SELECT count(*) FROM transcripts WHERE processing_job_id=?",
            Integer.class, job);
    }

    private UUID transcriptId() {
        return jdbc.queryForObject("SELECT id FROM transcripts WHERE processing_job_id=?",
            UUID.class, job);
    }

    private void assertUnfinished() {
        assertThat(jobStatus()).isEqualTo("RUNNING");
        assertThat(finalStageStatus()).isEqualTo("RUNNING");
        assertThat(transcriptCount()).isZero();
    }

    @Test
    void directRunningPublicationCannotCommitWithoutCompletingStageAndJob() {
        assertThatThrownBy(() ->
            transcripts.publishDuringFinalization(result("Orphaned publication rejected.")))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("must complete in one transaction");
        assertUnfinished();
    }

    @Test
    void finalizationStageSuccessWithoutJobCompletionRollsBackBothWrites() {
        assertThatThrownBy(() -> transactions.executeWithoutResult(status -> {
            transcripts.publishDuringFinalization(result("Stage success without job success."));
            lifecycle.completeStage(finalizer, "SUCCEEDED", null, null);
        })).isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("must complete in one transaction");
        assertUnfinished();
    }

    @Test
    void legacyStandalonePublishRejectsRunningJobAndDoesNotCreateTranscript() {
        assertThatThrownBy(() -> review.publish(result("Standalone publish not eligible.")))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT));
        assertUnfinished();
    }

    @Test
    void runningJobPersistsTranscriptThenFinalizesStageAndCompletes() {
        assertUnfinished();
        finalization.finalizeTranscript(finalizer, result("Transcript checked against audio."));
        assertThat(jobStatus()).isEqualTo("COMPLETED");
        assertThat(finalStageStatus()).isEqualTo("SUCCEEDED");
        assertThat(transcriptCount()).isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT is_current FROM transcripts WHERE processing_job_id=?",
            Boolean.class, job)).isTrue();
        assertThat(jdbc.queryForObject(
            "SELECT source_stage_run_id FROM transcripts WHERE processing_job_id=?",
            UUID.class, job)).isEqualTo(finalizer.stageRunId());
        assertThat(jdbc.queryForObject(
            "SELECT status FROM transcripts WHERE processing_job_id=?",
            String.class, job)).isEqualTo("READY");
    }

    @Test
    void plannedDownstreamStageKeepsJobRunningUntilPipelineCompletes() {
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'GENERATING_SUMMARY',1,'PENDING')
            """, UUID.randomUUID(), job);
        TranscriptResult accepted = result("Validated and corrected transcript.");
        finalization.finalizeTranscript(finalizer, accepted);
        assertThat(jobStatus()).isEqualTo("RUNNING");
        assertThat(finalStageStatus()).isEqualTo("SUCCEEDED");
        assertThat(transcriptCount()).isEqualTo(1);
        finalization.finalizeTranscript(finalizer, accepted);
        assertThat(transcriptCount()).isEqualTo(1);
        assertThatThrownBy(() -> lifecycle.completeJob(job))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        StageClaim summary = lifecycle.startStage(job, "GENERATING_SUMMARY", "llm", "summary");
        lifecycle.completeStage(summary, "SUCCEEDED", null, null);
        lifecycle.completeJob(job);
        assertThat(jobStatus()).isEqualTo("COMPLETED");
    }

    @Test
    void plannedDownstreamFailurePreservesReadableTranscript() {
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'GENERATING_SUMMARY',1,'PENDING')
            """, UUID.randomUUID(), job);
        finalization.finalizeTranscript(finalizer, result("Canonical transcript persists."));
        StageClaim summary = lifecycle.startStage(job, "GENERATING_SUMMARY", "llm", "summary");
        lifecycle.failStage(summary, "SUMMARY_FAILED", "Summary provider failed.", true);
        assertThat(jobStatus()).isEqualTo("FAILED");
        assertThat(transcriptCount()).isEqualTo(1);
        assertThat(transcripts.current(meeting)).isPresent();
    }

    @Test
    void warningsProduceDurableTranscriptAndWarningJobWithoutCallerCompletionFlag() {
        TranscriptResult warned = makeResult("Review required.",
            TranscriptIngestion.Status.READY_WITH_WARNINGS, "SUSPICIOUS", "SUSPICIOUS");
        finalization.finalizeTranscript(finalizer, warned);
        assertThat(jobStatus()).isEqualTo("COMPLETED_WITH_WARNINGS");
        assertThat(finalStageStatus()).isEqualTo("SUCCEEDED_WITH_WARNING");
        assertThat(jdbc.queryForObject(
            "SELECT status FROM transcripts WHERE processing_job_id=?",
            String.class, job)).isEqualTo("READY_WITH_WARNINGS");
        assertThat(jdbc.queryForObject(
            "SELECT warning_summary FROM processing_jobs WHERE id=?",
            String.class, job)).isNotBlank();
    }

    @Test
    void completedRedeliveryLeavesOneVersionAndDoesNotBumpJobVersion() {
        TranscriptResult original = result("Same result redelivered.");
        finalization.finalizeTranscript(finalizer, original);
        UUID canonical = transcriptId();
        Long version = jdbc.queryForObject("SELECT version FROM processing_jobs WHERE id=?",
            Long.class, job);
        finalization.finalizeTranscript(finalizer, original);
        assertThat(transcriptId()).isEqualTo(canonical);
        assertThat(transcriptCount()).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT version FROM processing_jobs WHERE id=?",
            Long.class, job)).isEqualTo(version);
    }

    @Test
    void conflictingRedeliveryCannotOverwriteFinalizedTranscript() {
        finalization.finalizeTranscript(finalizer, result("Original canonical text."));
        UUID canonical = transcriptId();
        assertThatThrownBy(() ->
            finalization.finalizeTranscript(finalizer, result("Different AI payload.")))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT));
        assertThat(transcriptId()).isEqualTo(canonical);
        assertThat(jobStatus()).isEqualTo("COMPLETED");
        assertThat(transcriptCount()).isEqualTo(1);
    }

    @Test
    void forgedWorkerClaimCannotWriteTranscriptOrFinishStage() {
        StageClaim forged = new StageClaim(finalizer.stageRunId(), UUID.randomUUID());
        assertThatThrownBy(() -> finalization.finalizeTranscript(forged, result("Forged result.")))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertUnfinished();
    }

    @Test
    void finalizationClaimMustMatchTranscriptStageAndJobProvenance() {
        assertThatThrownBy(() -> finalization.finalizeTranscript(transcription, result("Wrong claim.")))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> finalization.finalizeTranscript(finalizer,
            new TranscriptResult(meeting, media, UUID.randomUUID(), finalizer.stageRunId(), "vi",
                10000L, TranscriptIngestion.Status.READY,
                result("mismatch").segments(), result("mismatch").coverage(), List.of())))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertUnfinished();
    }

    @Test
    void expiredWorkerCannotCommitResultOrTransitionJob() {
        jdbc.update("""
            UPDATE processing_stage_runs
            SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=?
            """, finalizer.stageRunId());
        assertThatThrownBy(() ->
            finalization.finalizeTranscript(finalizer, result("Expired worker.")))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertUnfinished();
    }

    @Test
    void transcriptSegmentInsertFailureRollsBackAllFinalizationWrites() {
        TranscriptResult valid = result("Valid text.");
        TranscriptResult malformed = new TranscriptResult(valid.meetingId(),
            valid.sourceMediaId(), valid.processingJobId(), valid.sourceStageRunId(),
            valid.languageCode(), valid.durationMs(), valid.status(),
            List.of(
                new SegmentResult(0, 100, 400, "First.", "ACCEPTED", null,
                    finalizer.stageRunId(), null),
                new SegmentResult(0, 400, 950, "Duplicate ordinal.", "ACCEPTED", null,
                    finalizer.stageRunId(), null)),
            List.of(new CoverageResult(100, 950, "COVERED", false, 0, null)), List.of());
        CorrectedTranscriptFixture.replace(jdbc, malformed);
        assertThatThrownBy(() -> finalization.finalizeTranscript(finalizer, malformed))
            .isInstanceOf(DataIntegrityViolationException.class);
        assertUnfinished();
        CorrectedTranscriptFixture.replace(jdbc, valid);
        finalization.finalizeTranscript(finalizer, valid);
        assertThat(jobStatus()).isEqualTo("COMPLETED");
    }

    @Test
    void completionEvidenceFailureRollsBackTranscriptAndStageSuccess() {
        jdbc.update("UPDATE processing_stage_runs SET status='FAILED' WHERE id=?",
            transcription.stageRunId());
        assertThatThrownBy(() ->
            finalization.finalizeTranscript(finalizer, result("Not enough evidence.")))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertUnfinished();
        jdbc.update("UPDATE processing_stage_runs SET status='SUCCEEDED' WHERE id=?",
            transcription.stageRunId());
        finalization.finalizeTranscript(finalizer, result("Now evidence exists."));
        assertThat(jobStatus()).isEqualTo("COMPLETED");
    }

    @Test
    void invalidQualityRollsBackWithoutIncompleteTranscriptVersion() {
        TranscriptResult invalid = makeResult("Unsupported READY assertion.",
            TranscriptIngestion.Status.READY, "SUSPICIOUS", "SUSPICIOUS");
        assertThatThrownBy(() -> finalization.finalizeTranscript(finalizer, invalid))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY));
        assertUnfinished();
    }

    @Test
    void concurrentIdenticalFinalizationDeliversExactlyOneCanonicalTranscript() throws Exception {
        TranscriptResult input = result("Exactly once committed.");
        try (var pool = Executors.newFixedThreadPool(2)) {
            CountDownLatch gate = new CountDownLatch(1);
            var first = pool.submit(() -> { gate.await(); finalization.finalizeTranscript(finalizer, input); return true; });
            var second = pool.submit(() -> { gate.await(); finalization.finalizeTranscript(finalizer, input); return true; });
            gate.countDown();
            assertThat(first.get(20, TimeUnit.SECONDS)).isTrue();
            assertThat(second.get(20, TimeUnit.SECONDS)).isTrue();
        }
        assertThat(transcriptCount()).isEqualTo(1);
        assertThat(jobStatus()).isEqualTo("COMPLETED");
    }

    @Test
    void concurrentConflictingFinalizationCannotPublishTwoTranscripts() throws Exception {
        try (var pool = Executors.newFixedThreadPool(2)) {
            CountDownLatch gate = new CountDownLatch(1);
            var first = pool.submit(() -> {
                gate.await();
                finalization.finalizeTranscript(finalizer, result("Payload A."));
                return true;
            });
            var second = pool.submit(() -> {
                gate.await();
                finalization.finalizeTranscript(finalizer, result("Payload B."));
                return true;
            });
            gate.countDown();
            int accepted = 0, rejected = 0;
            for (var task : List.of(first, second)) {
                try {
                    assertThat(task.get(20, TimeUnit.SECONDS)).isTrue();
                    accepted++;
                } catch (ExecutionException exception) {
                    assertThat(exception.getCause()).isInstanceOf(ResponseStatusException.class);
                    assertThat(((ResponseStatusException) exception.getCause()).getStatusCode())
                        .isEqualTo(HttpStatus.CONFLICT);
                    rejected++;
                }
            }
            assertThat(accepted).isEqualTo(1);
            assertThat(rejected).isEqualTo(1);
        }
        assertThat(transcriptCount()).isEqualTo(1);
    }
}
