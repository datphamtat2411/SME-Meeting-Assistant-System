package com.sme.meetingassistant.api.media;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.sme.meetingassistant.api.integration.TranscriptFinalizationService;
import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.repository.MediaRepository.ProcessingLifecycleConflictException;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycleService;
import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.media.worker.TranscriptionWorkerCapability;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository;
import com.sme.meetingassistant.api.transcript.service.TranscriptCorrectionDigest;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.*;
import java.security.Principal;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@ActiveProfiles("test")
@SpringBootTest(properties = {"app.media.outbox.enabled=false",
    "app.media.processing.stage-lease-sweep-ms=3600000"})
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class DiarizationLifecycleIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired MediaProperties properties;
    @Autowired ProcessingJobLifecycle lifecycle;
    @Autowired ProcessingJobLifecycleService recovery;
    @Autowired TranscriptFinalizationService finalization;
    @Autowired TranscriptRepository transcripts;
    @Autowired MediaRepository repository;
    @Autowired TransactionTemplate transactions;
    @MockitoBean ObjectStorage storage;
    @MockitoBean TranscriptionWorkerCapability transcriptionWorker;
    UUID actor, meeting, media, job;
    StageClaim finalizer;

    @BeforeEach
    void fixture() {
        actor = UUID.randomUUID(); meeting = UUID.randomUUID(); media = UUID.randomUUID();
        properties.getProcessing().setDiarizationEnabled(true);
        properties.getProcessing().setRequiredDownstreamStages(List.of());
        properties.getProcessing().setMaxRetries(2);
        String email = actor + "@spk07.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'SPK07','test-only','EMPLOYEE','ACTIVE')
            """, actor, email, email);
        jdbc.update("INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id) VALUES (?,'SPK07',?,?)",
            meeting, actor, actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
              content_type,expected_size_bytes,size_bytes,duration_ms,sha256,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',1024,1024,10000,?,?,CURRENT_TIMESTAMP)
            """, media, meeting, "meetings/" + meeting + "/sources/" + media,
            "meetings/" + meeting + "/pending/" + media, "a".repeat(64), actor);
    }

    private Principal asActor() { return () -> actor.toString(); }

    private UUID admit() throws Exception {
        var response = mvc.perform(post("/api/v1/meetings/" + meeting + "/processing-jobs")
            .principal(asActor()).header("Idempotency-Key", "admit")
            .contentType(MediaType.APPLICATION_JSON).content("{\"mediaId\":\"" + media + "\"}"))
            .andReturn().getResponse();
        assertThat(response.getStatus()).isEqualTo(202);
        job = UUID.fromString(json.readTree(response.getContentAsString()).path("data").path("id").asText());
        return job;
    }

    private int retry(String key, String stage) throws Exception {
        return mvc.perform(post("/api/v1/processing-jobs/" + job + "/retry")
            .principal(asActor()).header("Idempotency-Key", key).contentType(MediaType.APPLICATION_JSON)
            .content(stage == null ? "{}" : "{\"stageCode\":\"" + stage + "\"}"))
            .andReturn().getResponse().getStatus();
    }

    private TranscriptResult prepareFinalization(boolean warning) {
        StageClaim asr = lifecycle.startStage(job, "TRANSCRIPTION", null, null);
        lifecycle.completeStage(asr, "SUCCEEDED", null, null);
        StageClaim correction = lifecycle.startStage(job, "CONTEXTUAL_CORRECTION", null, null);
        TranscriptResult draft = result(correction.stageRunId(), warning);
        lifecycle.completeStage(correction, "SUCCEEDED", null,
            "{\"contextScope\":\"WHOLE_MEETING\",\"outputSha256\":\""
                + TranscriptCorrectionDigest.sha256(draft) + "\",\"promptVersion\":\"spk07\"}");
        finalizer = lifecycle.startStage(job, "FINALIZING_TRANSCRIPT", null, null);
        return result(finalizer.stageRunId(), warning);
    }

    private TranscriptResult result(UUID stage, boolean warning) {
        return new TranscriptResult(meeting, media, job, stage, "vi", 10000L,
            warning ? Status.READY_WITH_WARNINGS : Status.READY,
            List.of(new SegmentResult(0, 100, 1200, "Canonical corrected transcript.",
                warning ? "SUSPICIOUS" : "ACCEPTED", null, stage, null)),
            List.of(new CoverageResult(100, 1200, warning ? "SUSPICIOUS" : "COVERED", false, 0, null)),
            List.of());
    }

    private void finalizeTranscript() throws Exception {
        admit();
        TranscriptResult accepted = prepareFinalization(false);
        finalization.finalizeTranscript(finalizer, accepted);
    }

    private StageClaim prepareClaim() { prepareFinalization(false); return finalizer; }
    private StageClaim start() { return lifecycle.startStage(job, "DIARIZING", "diarization", "model-v1"); }
    private String status() { return jdbc.queryForObject("SELECT status FROM processing_jobs WHERE id=?", String.class, job); }
    private int dispatches() { return jdbc.queryForObject("SELECT count(*) FROM outbox_events WHERE aggregate_id=? AND event_type='PROCESSING_DIARIZATION_REQUESTED'", Integer.class, job); }
    private JsonNode event() { return json.readTree(jdbc.queryForObject("SELECT payload::text FROM outbox_events WHERE aggregate_id=? AND event_type='PROCESSING_DIARIZATION_REQUESTED' ORDER BY occurred_at DESC LIMIT 1", String.class, job)); }
    private long stages(String code) { return jdbc.queryForObject("SELECT count(*) FROM processing_stage_runs WHERE processing_job_id=? AND stage_code=?", Long.class, job, code); }

    @Test
    void defaultOffAndAdmissionDecisionIsDurableAcrossConfigurationChanges() throws Exception {
        assertThat(new MediaProperties().getProcessing().isDiarizationEnabled()).isFalse();
        properties.getProcessing().setDiarizationEnabled(false);
        UUID first = admit();
        properties.getProcessing().setDiarizationEnabled(true);
        assertThat(admit()).isEqualTo(first);
        assertThat(stages("DIARIZING")).isZero();
        finalization.finalizeTranscript(prepareClaim(), result(finalizer.stageRunId(), false));
        assertThat(status()).isEqualTo("COMPLETED");
        assertThat(dispatches()).isZero();
        assertThatThrownBy(this::start).isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThatThrownBy(() -> jdbc.update("UPDATE processing_jobs SET diarization_planned=TRUE WHERE id=?", job))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void enabledAdmissionPlansExactlyOnePendingAttemptWithoutDispatchingInference() throws Exception {
        UUID first = admit();
        properties.getProcessing().setDiarizationEnabled(false);
        assertThat(admit()).isEqualTo(first);
        assertThat(stages("DIARIZING")).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT status FROM processing_stage_runs WHERE processing_job_id=? AND stage_code='DIARIZING'", String.class, job)).isEqualTo("PENDING");
        assertThat(dispatches()).isZero();
        assertThatThrownBy(this::start).isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThat(status()).isEqualTo("PENDING");
        finalization.finalizeTranscript(prepareClaim(), result(finalizer.stageRunId(), false));
        assertThat(dispatches()).isEqualTo(1);
        assertThat(status()).isEqualTo("RUNNING");
        assertThat(transcripts.current(meeting)).isPresent();
    }

    @Test
    void historicalUnplannedJobsCannotAcquireAnUnadmittedDiarizationStage() throws Exception {
        properties.getProcessing().setDiarizationEnabled(false);
        admit();
        assertThatThrownBy(this::start).isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThatThrownBy(() -> jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'DIARIZING',1,'PENDING')
            """, UUID.randomUUID(), job)).isInstanceOf(DataIntegrityViolationException.class);
        assertThat(stages("DIARIZING")).isZero();
    }

    @Test
    void derivedSummaryAdmissionNeverPlansDiarization() throws Exception {
        properties.getProcessing().setDiarizationEnabled(false);
        finalizeTranscript();
        UUID derived = UUID.randomUUID();
        properties.getProcessing().setDiarizationEnabled(true);
        transactions.executeWithoutResult(tx -> repository.insertDerivedSummaryJobAndOutbox(
            derived, meeting, media, actor, job, UUID.randomUUID()));
        assertThat(jdbc.queryForList("SELECT stage_code FROM processing_stage_runs WHERE processing_job_id=?", String.class, derived))
            .containsExactly("GENERATING_SUMMARY");
        assertThat(jdbc.queryForObject("SELECT diarization_planned FROM processing_jobs WHERE id=?", Boolean.class, derived)).isFalse();
    }

    @Test
    void finalizationDispatchPinsOnlyAuthoritativeIdentityAndIsIdempotent() throws Exception {
        admit();
        TranscriptResult accepted = prepareFinalization(false);
        finalization.finalizeTranscript(finalizer, accepted);
        JsonNode original = event();
        var transcript = transcripts.current(meeting).orElseThrow();
        assertThat(original.path("processingJobId").asText()).isEqualTo(job.toString());
        assertThat(original.path("meetingId").asText()).isEqualTo(meeting.toString());
        assertThat(original.path("sourceMediaId").asText()).isEqualTo(media.toString());
        assertThat(original.path("sourceRevision").asText()).isEqualTo("a".repeat(64));
        assertThat(original.path("transcriptId").asText()).isEqualTo(transcript.id().toString());
        assertThat(original.path("transcriptRevision").asLong()).isZero();
        assertThat(original.path("stageRunId").asText()).isEqualTo(jdbc.queryForObject("SELECT id FROM processing_stage_runs WHERE processing_job_id=? AND stage_code='DIARIZING'", UUID.class, job).toString());
        assertThat(original.path("eventId").asText()).isNotBlank();
        assertThat(original.path("occurredAt").asText()).isNotBlank();
        assertThat(original.path("schemaVersion").isIntegralNumber()).isTrue();
        assertThat(original.path("schemaVersion").intValue()).isEqualTo(1);
        assertThat(original.size()).isEqualTo(10);
        assertThat(original.toString()).doesNotContain("Canonical", "objectKey", "https:", "claimToken");
        finalization.finalizeTranscript(finalizer, accepted);
        assertThat(dispatches()).isEqualTo(1);
        assertThat(event()).isEqualTo(original);
        assertThatThrownBy(() -> jdbc.update("UPDATE outbox_events SET payload=jsonb_set(payload,'{schemaVersion}','2'::jsonb) WHERE id=?",
            UUID.fromString(original.path("eventId").asText()))).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update("UPDATE processing_diarization_dispatches SET transcript_revision=1 WHERE processing_job_id=?", job))
            .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update("""
            INSERT INTO processing_diarization_dispatches(stage_run_id,processing_job_id,meeting_id,
              source_media_id,source_revision,transcript_id,transcript_revision,event_id,created_at)
            SELECT stage_run_id,processing_job_id,meeting_id,source_media_id,source_revision,
              transcript_id,transcript_revision,event_id,created_at
            FROM processing_diarization_dispatches WHERE processing_job_id=?
            """, job))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void concurrentFinalizationCreatesOneLogicalDispatch() throws Exception {
        admit();
        TranscriptResult accepted = prepareFinalization(false);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var gate = new CountDownLatch(1);
            var first = pool.submit(() -> { gate.await(); finalization.finalizeTranscript(finalizer, accepted); return true; });
            var second = pool.submit(() -> { gate.await(); finalization.finalizeTranscript(finalizer, accepted); return true; });
            gate.countDown();
            assertThat(first.get(20, TimeUnit.SECONDS)).isTrue();
            assertThat(second.get(20, TimeUnit.SECONDS)).isTrue();
        }
        assertThat(dispatches()).isEqualTo(1);
        assertThat(stages("DIARIZING")).isEqualTo(1);
    }

    @Test
    void rollbackLeavesNoPublishedTranscriptOrDispatchAndMissingSourceRevisionFailsClosed() throws Exception {
        admit();
        TranscriptResult accepted = prepareFinalization(false);
        transactions.executeWithoutResult(tx -> { finalization.finalizeTranscript(finalizer, accepted); tx.setRollbackOnly(); });
        assertThat(transcripts.current(meeting)).isEmpty();
        assertThat(dispatches()).isZero();
        jdbc.update("UPDATE meeting_media SET sha256=NULL WHERE id=?", media);
        assertThatThrownBy(() -> finalization.finalizeTranscript(finalizer, accepted))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThat(transcripts.current(meeting)).isEmpty();
        assertThat(dispatches()).isZero();
        assertThat(jdbc.queryForObject("SELECT status FROM processing_stage_runs WHERE id=?", String.class, finalizer.stageRunId())).isEqualTo("RUNNING");
    }

    @Test
    void atomicPublicationGuardRequiresDispatchForPlannedDiarization() throws Exception {
        admit();
        TranscriptResult accepted = prepareFinalization(false);
        assertThatThrownBy(() -> transactions.executeWithoutResult(tx -> {
            transcripts.publishDuringFinalization(accepted);
            lifecycle.completeStage(finalizer, "SUCCEEDED", null, null);
        })).isInstanceOf(IllegalStateException.class);
        assertThat(transcripts.current(meeting)).isEmpty();
        assertThat(dispatches()).isZero();
    }

    @Test
    void pendingAndRunningDiarizationBlockCompletionAndAllDownstreamClaims() throws Exception {
        properties.getProcessing().setRequiredDownstreamStages(List.of("INDEXING"));
        finalizeTranscript();
        assertThat(lifecycle.hasPendingPipelineStages(job)).isTrue();
        assertThatThrownBy(() -> lifecycle.completeJob(job)).isInstanceOf(ProcessingLifecycleConflictException.class);
        for (String code : List.of("GENERATING_SUMMARY", "EXTRACTING_DECISIONS", "INDEXING"))
            assertThatThrownBy(() -> lifecycle.startStage(job, code, null, null)).isInstanceOf(ProcessingLifecycleConflictException.class);
        StageClaim diarization = start();
        assertThatThrownBy(this::start).isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThatThrownBy(() -> lifecycle.startStage(job, "INDEXING", null, null)).isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThatThrownBy(() -> lifecycle.completeJob(job)).isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThatThrownBy(() -> lifecycle.completeStage(diarization, "SUCCEEDED", null, null))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        lifecycle.failStage(diarization, "DIARIZATION_FAILED", null, true);
        StageClaim indexing = lifecycle.startStage(job, "INDEXING", null, null);
        lifecycle.completeStage(indexing, "SUCCEEDED", null, null);
        lifecycle.completeJob(job);
        assertThat(status()).isEqualTo("COMPLETED_WITH_WARNINGS");
    }

    @Test
    void optionalFailureRemainsFailedAndDownstreamContinuesWithoutChangingTranscript() throws Exception {
        properties.getProcessing().setRequiredDownstreamStages(List.of("INDEXING"));
        finalizeTranscript();
        var original = transcripts.current(meeting).orElseThrow();
        StageClaim diarization = start();
        lifecycle.failStage(diarization, "DIARIZATION_FAILED", "secret provider text", true);
        lifecycle.failStage(diarization, "DIARIZATION_FAILED", "different secret", true);
        assertThat(status()).isEqualTo("RUNNING");
        assertThat(jdbc.queryForObject("SELECT status FROM processing_stage_runs WHERE id=?", String.class, diarization.stageRunId())).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("SELECT error_summary FROM processing_stage_runs WHERE id=?", String.class, diarization.stageRunId())).isEqualTo("Speaker diarization failed.");
        StageClaim indexing = lifecycle.startStage(job, "INDEXING", null, null);
        lifecycle.completeStage(indexing, "SUCCEEDED", null, null);
        lifecycle.completeJob(job);
        assertThat(status()).isEqualTo("COMPLETED_WITH_WARNINGS");
        assertThat(jdbc.queryForObject("SELECT warning_summary FROM processing_jobs WHERE id=?", String.class, job)).contains("DIARIZING").doesNotContain("secret");
        assertThat(transcripts.current(meeting).orElseThrow()).isEqualTo(original);
    }

    @Test
    void requiredFailureStillFailsJobAfterOptionalFailure() throws Exception {
        properties.getProcessing().setRequiredDownstreamStages(List.of("INDEXING"));
        finalizeTranscript();
        lifecycle.failStage(start(), "DIARIZATION_FAILED", null, true);
        lifecycle.failStage(lifecycle.startStage(job, "INDEXING", null, null), "INDEXING_FAILED", null, true);
        assertThat(status()).isEqualTo("FAILED");
        assertThatThrownBy(() -> lifecycle.completeJob(job)).isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThat(retry("optional-cannot-hide-required", "DIARIZING")).isEqualTo(409);
    }

    @Test
    void retryReopensWarningJobAppendsAttemptAndFreshBindingWithIdempotentAdmission() throws Exception {
        finalizeTranscript();
        StageClaim failed = start();
        lifecycle.failStage(failed, "DIARIZATION_FAILED", null, true);
        assertThat(status()).isEqualTo("COMPLETED_WITH_WARNINGS");
        UUID transcript = transcripts.current(meeting).orElseThrow().id();
        jdbc.update("UPDATE transcripts SET content_revision=content_revision+1 WHERE id=?", transcript);
        assertThat(retry("retry-1", "DIARIZING")).isEqualTo(202);
        assertThat(retry("retry-1", "DIARIZING")).isEqualTo(202);
        assertThat(status()).isEqualTo("RUNNING");
        assertThat(stages("DIARIZING")).isEqualTo(2);
        assertThat(dispatches()).isEqualTo(2);
        assertThat(event().path("schemaVersion").isIntegralNumber()).isTrue();
        assertThat(event().path("schemaVersion").intValue()).isEqualTo(1);
        assertThat(stages("TRANSCRIPTION")).isEqualTo(1);
        assertThat(stages("CONTEXTUAL_CORRECTION")).isEqualTo(1);
        assertThat(stages("FINALIZING_TRANSCRIPT")).isEqualTo(1);
        assertThat(jdbc.queryForList("SELECT transcript_revision FROM processing_diarization_dispatches WHERE processing_job_id=? ORDER BY transcript_revision", Long.class, job)).containsExactly(0L, 1L);
        assertThat(jdbc.queryForObject("SELECT error_code FROM processing_stage_runs WHERE id=?", String.class, failed.stageRunId())).isEqualTo("DIARIZATION_FAILED");
        assertThatThrownBy(() -> lifecycle.completeStage(failed, "SUCCEEDED", null, null)).isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThatThrownBy(() -> lifecycle.renewStageLease(failed)).isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThatThrownBy(() -> lifecycle.failStage(failed, "DIARIZATION_FAILED", null, true)).isInstanceOf(ProcessingLifecycleConflictException.class);
        var retried = start();
        assertThatThrownBy(() -> lifecycle.completeStage(retried, "SUCCEEDED", null, null))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThatThrownBy(() -> lifecycle.completeJob(job)).isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThat(status()).isEqualTo("RUNNING");
        assertThat(transcripts.current(meeting).orElseThrow().id()).isEqualTo(transcript);
        assertThat(transcripts.current(meeting).orElseThrow().contentRevision()).isEqualTo(1);
    }

    @Test
    void retryRespectsFinitePolicyAndRequiresExplicitRetryableDiarizationFailure() throws Exception {
        finalizeTranscript();
        lifecycle.failStage(start(), "DIARIZATION_FAILED", null, true);
        assertThat(retry("job-only", null)).isEqualTo(409);
        properties.getProcessing().setMaxRetries(0);
        assertThat(retry("disabled", "DIARIZING")).isEqualTo(409);
        properties.getProcessing().setMaxRetries(1);
        assertThat(retry("allowed", "DIARIZING")).isEqualTo(202);
        lifecycle.failStage(start(), "DIARIZATION_FAILED", null, true);
        assertThat(retry("exhausted", "DIARIZING")).isEqualTo(409);
        assertThat(stages("DIARIZING")).isEqualTo(2);
    }

    @Test
    void nonRetryableFailureCannotBeRetried() throws Exception {
        finalizeTranscript();
        lifecycle.failStage(start(), "DIARIZATION_FAILED", null, false);
        assertThat(retry("no", "DIARIZING")).isEqualTo(409);
        assertThat(dispatches()).isEqualTo(1);
    }

    @Test
    void isolatedRetryCannotCompeteWithActiveStage() throws Exception {
        properties.getProcessing().setRequiredDownstreamStages(List.of("INDEXING"));
        finalizeTranscript();
        lifecycle.failStage(start(), "DIARIZATION_FAILED", null, true);
        StageClaim indexing = lifecycle.startStage(job, "INDEXING", null, null);
        assertThat(retry("conflicting", "DIARIZING")).isEqualTo(409);
        lifecycle.completeStage(indexing, "SUCCEEDED", null, null);
        assertThat(retry("eligible", "DIARIZING")).isEqualTo(202);
        assertThat(stages("DIARIZING")).isEqualTo(2);
    }

    @Test
    void concurrentIdenticalRetriesAppendOnlyOneAttemptAndDispatch() throws Exception {
        finalizeTranscript();
        lifecycle.failStage(start(), "DIARIZATION_FAILED", null, true);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var gate = new CountDownLatch(1);
            var first = pool.submit(() -> { gate.await(); return retry("same-retry", "DIARIZING"); });
            var second = pool.submit(() -> { gate.await(); return retry("same-retry", "DIARIZING"); });
            gate.countDown();
            assertThat(first.get(20, TimeUnit.SECONDS)).isEqualTo(202);
            assertThat(second.get(20, TimeUnit.SECONDS)).isEqualTo(202);
        }
        assertThat(dispatches()).isEqualTo(2);
        assertThat(stages("DIARIZING")).isEqualTo(2);
        assertThat(retry("same-retry", "INDEXING")).isEqualTo(409);
    }

    @Test
    void retryCannotReopenJobWhileAnotherJobOccupiesMeeting() throws Exception {
        finalizeTranscript();
        lifecycle.failStage(start(), "DIARIZATION_FAILED", null, true);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status,reprocess_of_job_id)
            VALUES (?,?,?,?,'PENDING',?)
            """, UUID.randomUUID(), meeting, media, actor, job);
        assertThat(retry("conflict", "DIARIZING")).isEqualTo(409);
        assertThat(status()).isEqualTo("COMPLETED_WITH_WARNINGS");
        assertThat(dispatches()).isEqualTo(1);
    }

    @Test
    void missingFinalizationProvenanceAndSupersededPublicationCannotAuthorizeExecution() throws Exception {
        finalizeTranscript();
        jdbc.update("UPDATE processing_stage_runs SET status='FAILED' WHERE id=?", finalizer.stageRunId());
        assertThatThrownBy(this::start).isInstanceOf(ProcessingLifecycleConflictException.class);
        jdbc.update("UPDATE processing_stage_runs SET status='SUCCEEDED' WHERE id=?", finalizer.stageRunId());
        jdbc.update("UPDATE transcripts SET is_current=FALSE WHERE processing_job_id=?", job);
        assertThatThrownBy(this::start).isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThat(status()).isEqualTo("RUNNING");
    }

    @Test
    void finalizationReplayAfterHumanRevisionDoesNotRewriteOriginalDispatch() throws Exception {
        admit();
        TranscriptResult accepted = prepareFinalization(false);
        finalization.finalizeTranscript(finalizer, accepted);
        JsonNode original = event();
        jdbc.update("UPDATE transcripts SET content_revision=1 WHERE processing_job_id=?", job);
        finalization.finalizeTranscript(finalizer, accepted);
        assertThat(event()).isEqualTo(original);
        assertThat(dispatches()).isEqualTo(1);
        assertThat(transcripts.current(meeting).orElseThrow().contentRevision()).isEqualTo(1);
    }

    @Test
    void stalePinnedTranscriptAndSourceCannotStartOrCompleteAttempt() throws Exception {
        finalizeTranscript();
        var originalEvent = event();
        jdbc.update("UPDATE transcripts SET content_revision=1 WHERE processing_job_id=?", job);
        assertThatThrownBy(this::start).isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThat(event()).isEqualTo(originalEvent);
        jdbc.update("UPDATE transcripts SET content_revision=0 WHERE processing_job_id=?", job);
        jdbc.update("UPDATE meeting_media SET sha256=? WHERE id=?", "b".repeat(64), media);
        assertThatThrownBy(this::start).isInstanceOf(ProcessingLifecycleConflictException.class);
        jdbc.update("UPDATE meeting_media SET sha256=? WHERE id=?", "a".repeat(64), media);
        StageClaim claim = start();
        assertThatThrownBy(() -> lifecycle.completeStage(new StageClaim(claim.stageRunId(), UUID.randomUUID()), "SUCCEEDED", null, null)).isInstanceOf(ProcessingLifecycleConflictException.class);
        jdbc.update("UPDATE transcripts SET content_revision=1 WHERE processing_job_id=?", job);
        assertThatThrownBy(() -> lifecycle.completeStage(claim, "SUCCEEDED", null, null)).isInstanceOf(ProcessingLifecycleConflictException.class);
        lifecycle.failStage(claim, "DIARIZATION_SOURCE_STALE", null, true);
        assertThat(status()).isEqualTo("COMPLETED_WITH_WARNINGS");
    }

    @Test
    void expiredDiarizationOwnerFailsOptionallyAndCannotRegainAuthority() throws Exception {
        finalizeTranscript();
        StageClaim expired = start();
        jdbc.update("UPDATE processing_stage_runs SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=?", expired.stageRunId());
        assertThatThrownBy(() -> lifecycle.completeStage(expired, "SUCCEEDED", null, null)).isInstanceOf(ProcessingLifecycleConflictException.class);
        recovery.expireAbandonedStages();
        assertThat(status()).isEqualTo("COMPLETED_WITH_WARNINGS");
        assertThat(jdbc.queryForObject("SELECT error_code FROM processing_stage_runs WHERE id=?", String.class, expired.stageRunId())).isEqualTo("STAGE_LEASE_EXPIRED");
        assertThat(retry("recovered", "DIARIZING")).isEqualTo(202);
        assertThatThrownBy(() -> lifecycle.renewStageLease(expired)).isInstanceOf(ProcessingLifecycleConflictException.class);
    }

    @Test
    void missingSpeakerProjectionCannotSucceedOrEraseTranscriptQualityWarnings() throws Exception {
        admit();
        TranscriptResult warned = prepareFinalization(true);
        finalization.finalizeTranscript(finalizer, warned);
        var claim=start();
        assertThatThrownBy(() -> lifecycle.completeStage(claim, "SUCCEEDED", null, null)).isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThat(status()).isEqualTo("RUNNING");
        assertThat(transcripts.current(meeting).orElseThrow().status()).isEqualTo("READY_WITH_WARNINGS");
    }

    @Test
    void brokerFailureAndExhaustionPreserveTranscriptAndPendingIntent() throws Exception {
        finalizeTranscript();
        var original = transcripts.current(meeting).orElseThrow();
        var originalEvent = event();
        UUID eventId = UUID.fromString(event().path("eventId").asText());
        jdbc.update("UPDATE outbox_events SET status='PUBLISHED' WHERE aggregate_id=? AND event_type='PROCESSING_JOB_QUEUED'", job);
        var first = repository.claimPendingOutbox(1000, 60, 2).stream().filter(e -> e.id().equals(eventId)).findFirst().orElseThrow();
        assertThat(repository.markPublishFailed(first.id(), first.claimToken(), first.attemptCount(), 2, "BrokerUnavailable")).isTrue();
        jdbc.update("UPDATE outbox_events SET next_attempt_at=CURRENT_TIMESTAMP WHERE id=?", eventId);
        var second = repository.claimPendingOutbox(1000, 60, 2).stream().filter(e -> e.id().equals(eventId)).findFirst().orElseThrow();
        assertThat(second.payload()).isEqualTo(first.payload());
        assertThat(json.readTree(second.payload()).path("schemaVersion").isIntegralNumber()).isTrue();
        assertThat(json.readTree(second.payload()).path("schemaVersion").intValue()).isEqualTo(1);
        assertThat(repository.markPublishFailed(second.id(), second.claimToken(), second.attemptCount(), 2, "BrokerUnavailable")).isTrue();
        assertThat(jdbc.queryForObject("SELECT status FROM outbox_events WHERE id=?", String.class, eventId)).isEqualTo("FAILED");
        assertThat(status()).isEqualTo("RUNNING");
        assertThat(transcripts.current(meeting).orElseThrow()).isEqualTo(original);
        assertThat(dispatches()).isEqualTo(1);
        assertThat(event()).isEqualTo(originalEvent);
        assertThatThrownBy(() -> lifecycle.completeJob(job)).isInstanceOf(ProcessingLifecycleConflictException.class);
    }

    @Test
    void confirmedDispatchDoesNotGrantOwnershipOrCompleteStage() throws Exception {
        finalizeTranscript();
        UUID eventId = UUID.fromString(event().path("eventId").asText());
        jdbc.update("UPDATE outbox_events SET status='PUBLISHED' WHERE aggregate_id=? AND event_type='PROCESSING_JOB_QUEUED'", job);
        var notification = repository.claimPendingOutbox(1000, 60, 2).stream().filter(e -> e.id().equals(eventId)).findFirst().orElseThrow();
        assertThat(repository.markPublished(notification.id(), notification.claimToken())).isTrue();
        assertThat(status()).isEqualTo("RUNNING");
        assertThat(jdbc.queryForObject("SELECT status FROM processing_stage_runs WHERE processing_job_id=? AND stage_code='DIARIZING'", String.class, job)).isEqualTo("PENDING");
        assertThatThrownBy(() -> lifecycle.completeStage(new StageClaim(
            UUID.fromString(event().path("stageRunId").asText()), eventId), "SUCCEEDED", null, null))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
    }
}
