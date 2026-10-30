package com.sme.meetingassistant.api.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.repository.MediaRepository.Job;
import com.sme.meetingassistant.api.media.repository.MediaRepository.ProcessingLifecycleConflictException;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.transcript.service.TranscriptCorrectionDigest;
import com.sme.meetingassistant.api.integration.TranscriptFinalizationService;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.*;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.web.server.ResponseStatusException;

/** INT-03B: real DB evidence gate for new processing jobs, not a naming/comment convention. */
@ActiveProfiles("test")
@SpringBootTest(properties = {
    "app.media.outbox.enabled=false",
    "app.media.processing.stage-lease-sweep-ms=3600000"
})
@Import(PostgresTestConfiguration.class)
class ContextualCorrectionGateIntegrationTests {
    @Autowired MediaRepository mediaRepository;
    @Autowired ProcessingJobLifecycle lifecycle;
    @Autowired TranscriptFinalizationService finalization;
    @Autowired JdbcTemplate jdbc;
    private UUID meeting;
    private UUID media;
    private UUID job;

    @BeforeEach
    void setup() {
        UUID actor = UUID.randomUUID();
        meeting = UUID.randomUUID();
        media = UUID.randomUUID();
        job = UUID.randomUUID();
        String email = "context-evidence-" + actor + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Correction gate test','test-only','EMPLOYEE','ACTIVE')
            """, actor, email, email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Contextual correction gate',?,?)
            """, meeting, actor, actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
              content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',1024,1024,10000,?,CURRENT_TIMESTAMP)
            """, media, meeting, "meetings/" + meeting + "/sources/" + media,
            "meetings/" + meeting + "/pending/" + media, actor);
        OffsetDateTime now = OffsetDateTime.now();
        mediaRepository.insertJobAndOutbox(new Job(job, meeting, media,
            "OFFLINE_MEETING_PROCESSING", "PENDING", actor, null, 0,
            null, null, null, null, null, null, now, now), UUID.randomUUID(), List.of());
        StageClaim transcript = lifecycle.startStage(job, "TRANSCRIPTION", "whisper", "large-v3");
        lifecycle.completeStage(transcript, "SUCCEEDED", null, "{\"coverageValidated\":true}");
    }

    private TranscriptResult result(UUID finalizer, String text) {
        return new TranscriptResult(meeting, media, job, finalizer, "vi", 10000L,
            TranscriptIngestion.Status.READY,
            List.of(new SegmentResult(0, 100, 1250, text, "ACCEPTED", null, finalizer, null)),
            List.of(new CoverageResult(100, 1250, "COVERED", false, 0, null)),
            List.of());
    }

    private String proof(String forText) {
        String hash = TranscriptCorrectionDigest.sha256(result(UUID.randomUUID(), forText));
        return "{\"contextScope\":\"WHOLE_MEETING\",\"outputSha256\":\"" + hash
            + "\",\"promptVersion\":\"context-v1\"}";
    }

    private String jobStatus() {
        return jdbc.queryForObject("SELECT status FROM processing_jobs WHERE id=?", String.class, job);
    }

    @Test
    void admittedJobRequiresCorrectionAndRejectsUnprovenStageSuccess() {
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM processing_stage_runs
            WHERE processing_job_id=? AND stage_code='CONTEXTUAL_CORRECTION' AND status='PENDING'
            """, Integer.class, job)).isEqualTo(1);
        assertThatThrownBy(() -> lifecycle.startStage(job, "FINALIZING_TRANSCRIPT", null, null))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        StageClaim correction = lifecycle.startStage(job, "CONTEXTUAL_CORRECTION", "llm", "multilingual");
        assertThatThrownBy(() -> lifecycle.completeStage(correction, "SUCCEEDED", null, "{}"))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        lifecycle.completeStage(correction, "SUCCEEDED", null, proof("Vietnamese canonical text."));
        StageClaim finalizer = lifecycle.startStage(job, "FINALIZING_TRANSCRIPT", null, null);
        finalization.finalizeTranscript(finalizer, result(finalizer.stageRunId(), "Vietnamese canonical text."));
        assertThat(jobStatus()).isEqualTo("COMPLETED");
        assertThat(jdbc.queryForObject("SELECT count(*) FROM transcripts WHERE processing_job_id=?",
            Integer.class, job)).isEqualTo(1);
    }

    @Test
    void wrongCorrectedTextDigestNeverPublishesTranscriptOrCompletesJob() {
        StageClaim correction = lifecycle.startStage(job, "CONTEXTUAL_CORRECTION", "llm", "multilingual");
        lifecycle.completeStage(correction, "SUCCEEDED", null, proof("Correction output A."));
        StageClaim finalizer = lifecycle.startStage(job, "FINALIZING_TRANSCRIPT", null, null);
        assertThatThrownBy(() ->
            finalization.finalizeTranscript(finalizer, result(finalizer.stageRunId(), "Unverified output B.")))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(err -> assertThat(((ResponseStatusException) err).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT));
        assertThat(jobStatus()).isEqualTo("RUNNING");
        assertThat(jdbc.queryForObject("SELECT count(*) FROM transcripts WHERE processing_job_id=?",
            Integer.class, job)).isZero();
    }

    @Test
    void failedCorrectionCannotBeBypassedByAValidLookingTranscript() {
        StageClaim correction = lifecycle.startStage(job, "CONTEXTUAL_CORRECTION", "llm", "multilingual");
        lifecycle.failStage(correction, "LLM_CORRECTION_FAILED", "Contextual correction failed.", true);
        assertThat(jobStatus()).isEqualTo("FAILED");
        assertThatThrownBy(() -> lifecycle.startStage(job, "FINALIZING_TRANSCRIPT", null, null))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
    }
}
