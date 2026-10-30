package com.sme.meetingassistant.api.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.repository.MediaRepository.Job;
import com.sme.meetingassistant.api.media.repository.MediaRepository.ProcessingLifecycleConflictException;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository;
import com.sme.meetingassistant.api.transcript.service.TranscriptCorrectionDigest;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.CoverageResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.SegmentResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.TranscriptResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.Status;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * INT-03F: Combined acceptance with PostgreSQL-backed job/stage/lineage and
 * durable retry. The model output is a validated fake AI result; this test
 * intentionally does not contact an external Whisper/LLM model or RabbitMQ.
 */
@ActiveProfiles("test")
@SpringBootTest(properties = {
    "app.media.outbox.enabled=false",
    "app.media.processing.stage-lease-sweep-ms=3600000"
})
@Import(PostgresTestConfiguration.class)
class CombinedMediaTranscriptPipelineAcceptanceTests {
    @Autowired MediaRepository media;
    @Autowired ProcessingJobLifecycle lifecycle;
    @Autowired TranscriptFinalizationService finalization;
    @Autowired TranscriptRepository transcripts;
    @Autowired JdbcTemplate jdbc;
    @Autowired TransactionTemplate transactions;

    private UUID meetingId;
    private UUID mediaId;
    private UUID jobId;
    private static final String CORRECTED_TEXT = "Toàn bộ cuộc họp đã được hiệu chỉnh bằng ngữ cảnh.";

    @BeforeEach
    void admission() {
        UUID organizer = UUID.randomUUID();
        meetingId = UUID.randomUUID();
        mediaId = UUID.randomUUID();
        jobId = UUID.randomUUID();
        String email = "int03f-" + organizer + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Pipeline acceptance','test-only','EMPLOYEE','ACTIVE')
            """, organizer, email, email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'INT-03 full processing pipeline',?,?)
            """, meetingId, organizer, organizer);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
              content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',1024,1024,10000,?,CURRENT_TIMESTAMP)
            """, mediaId, meetingId, "meetings/" + meetingId + "/sources/" + mediaId,
            "meetings/" + meetingId + "/pending/" + mediaId, organizer);
        OffsetDateTime now = OffsetDateTime.now();
        // Snapshot only the stage implemented for this integration scenario,
        // keeping the real job contract immutable after admission.
        media.insertJobAndOutbox(new Job(jobId, meetingId, mediaId,
            "OFFLINE_MEETING_PROCESSING", "PENDING", organizer, null, 0,
            null, null, null, null, null, null, now, now), UUID.randomUUID(),
            List.of("GENERATING_SUMMARY"));
    }

    private TranscriptResult result(UUID stageId) {
        return new TranscriptResult(meetingId, mediaId, jobId, stageId, "vi", 10000L, Status.READY,
            List.of(new SegmentResult(0, 100, 1500, CORRECTED_TEXT, "ACCEPTED",
                null, stageId, null)),
            List.of(new CoverageResult(100, 1500, "COVERED", false, 0, null)),
            List.of());
    }

    private String state() {
        return jdbc.queryForObject("SELECT status FROM processing_jobs WHERE id=?", String.class, jobId);
    }

    @Test
    void correctedTranscriptRemainsCanonicalThroughSummaryFailureAndBoundedRetry() {
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM processing_stage_runs WHERE processing_job_id=?
              AND stage_code IN ('CONTEXTUAL_CORRECTION','GENERATING_SUMMARY')
                AND status='PENDING'
            """, Integer.class, jobId)).isEqualTo(2);
        StageClaim transcription = lifecycle.startStage(jobId, "TRANSCRIPTION", "whisper", "large-v3");
        lifecycle.completeStage(transcription, "SUCCEEDED", null,
            "{\"speech_coverage_validated\":true}");

        StageClaim contextual = lifecycle.startStage(jobId, "CONTEXTUAL_CORRECTION", "llm", "multilingual");
        String digest = TranscriptCorrectionDigest.sha256(result(UUID.randomUUID()));
        lifecycle.completeStage(contextual, "SUCCEEDED", null,
            "{\"contextScope\":\"WHOLE_MEETING\",\"outputSha256\":\"" + digest
                + "\",\"promptVersion\":\"context-v1\"}");

        StageClaim finalizer = lifecycle.startStage(jobId, "FINALIZING_TRANSCRIPT", null, null);
        TranscriptResult canonical = result(finalizer.stageRunId());
        finalization.finalizeTranscript(finalizer, canonical);
        UUID published = transcripts.current(meetingId).orElseThrow().id();
        assertThat(state()).isEqualTo("RUNNING");
        assertThat(transcripts.current(meetingId).orElseThrow().segments().getFirst().text())
            .isEqualTo(CORRECTED_TEXT);
        assertThatThrownBy(() -> lifecycle.completeJob(jobId))
            .isInstanceOf(ProcessingLifecycleConflictException.class);

        // Failure is scoped to downstream processing; transcript stays readable.
        StageClaim firstSummary = lifecycle.startStage(jobId, "GENERATING_SUMMARY", "llm", "summary-v1");
        lifecycle.failStage(firstSummary, "SUMMARY_PROVIDER_FAILURE",
            "Summary model temporarily unavailable.", true);
        assertThat(state()).isEqualTo("FAILED");
        assertThat(transcripts.current(meetingId).orElseThrow().id()).isEqualTo(published);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM transcripts WHERE processing_job_id=?",
            Integer.class, jobId)).isEqualTo(1);

        // A durable, transactional stage-only retry preserves completed upstream work.
        Job snapshot = media.findJob(jobId).orElseThrow();
        transactions.executeWithoutResult(tx ->
            assertThat(media.retryJobAndOutbox(snapshot, UUID.randomUUID(),
                "GENERATING_SUMMARY", 2)).isTrue());
        assertThat(state()).isEqualTo("PENDING");
        StageClaim resumedSummary = lifecycle.startStage(jobId, "GENERATING_SUMMARY", "llm", "summary-v1");
        assertThat(resumedSummary.stageRunId()).isNotEqualTo(firstSummary.stageRunId());
        assertThatThrownBy(() -> lifecycle.completeStage(firstSummary, "SUCCEEDED", null, null))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        lifecycle.completeStage(resumedSummary, "SUCCEEDED", null,
            "{\"validated\":true}");
        lifecycle.completeJob(jobId);

        assertThat(state()).isEqualTo("COMPLETED");
        assertThat(transcripts.current(meetingId).orElseThrow().id()).isEqualTo(published);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM processing_stage_runs
            WHERE processing_job_id=? AND stage_code='GENERATING_SUMMARY'
            """, Integer.class, jobId)).isEqualTo(2);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM processing_stage_runs
            WHERE processing_job_id=? AND stage_code='GENERATING_SUMMARY'
              AND status='FAILED' AND retryable
            """, Integer.class, jobId)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM outbox_events WHERE aggregate_id=?
              AND event_type='PROCESSING_JOB_RETRY_REQUESTED'
            """, Integer.class, jobId)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT retry_count FROM processing_jobs WHERE id=?",
            Integer.class, jobId)).isEqualTo(1);
        // The completed transcript result was never re-published on retry.
        finalization.finalizeTranscript(finalizer, canonical);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM transcripts WHERE processing_job_id=?",
            Integer.class, jobId)).isEqualTo(1);
    }
}
