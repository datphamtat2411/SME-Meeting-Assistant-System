package com.sme.meetingassistant.api.media;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.repository.MediaRepository.ProcessingLifecycleConflictException;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

/** Verifies job completion against committed stage and canonical transcript evidence. */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class ProcessingLifecycleInvariantsIntegrationTests {
    @Autowired ProcessingJobLifecycle lifecycle;
    @Autowired JdbcTemplate jdbc;
    private UUID meetingId;
    private UUID mediaId;
    private UUID jobId;

    @BeforeEach
    void fixture() {
        UUID actor = UUID.randomUUID();
        meetingId = UUID.randomUUID();
        mediaId = UUID.randomUUID();
        jobId = UUID.randomUUID();
        String email = "mp02-" + actor + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Lifecycle test','test-only','EMPLOYEE','ACTIVE')
            """, actor, email, email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Lifecycle invariants',?,?)
            """, meetingId, actor, actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',1024,1024,10000,?,CURRENT_TIMESTAMP)
            """, mediaId, meetingId, "meetings/" + meetingId + "/sources/" + mediaId,
            "meetings/" + meetingId + "/pending/" + mediaId, actor);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status,queued_at)
            VALUES (?,?,?,?,'QUEUED',CURRENT_TIMESTAMP)
            """, jobId, meetingId, mediaId, actor);
    }

    private String jobStatus() {
        return jdbc.queryForObject("SELECT status FROM processing_jobs WHERE id=?", String.class, jobId);
    }

    private StageClaim startTranscription(String outcome) {
        StageClaim stage = lifecycle.startStage(jobId, "TRANSCRIPTION", "whisper", "base");
        lifecycle.completeStage(stage, outcome, null, "{\"validated\":true}");
        return stage;
    }

    private StageClaim startFinalization() {
        return lifecycle.startStage(jobId, "FINALIZING_TRANSCRIPT", "llm", "contextual");
    }

    private UUID persistTranscript(StageClaim finalization, String status, String quality) {
        UUID transcript = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,source_stage_run_id,
              version_number,language_code,status,is_current,duration_ms,finalized_at)
            VALUES (?,?,?,?,?,1,'vi',?,TRUE,10000,CURRENT_TIMESTAMP)
            """, transcript, meetingId, mediaId, jobId, finalization.stageRunId(), status);
        jdbc.update("""
            INSERT INTO transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,current_text,quality_status)
            VALUES (?,?,0,0,1200,'A canonical LLM-corrected segment',?)
            """, UUID.randomUUID(), transcript, quality);
        return transcript;
    }

    private StageClaim completedTranscriptStages(String transcriptionOutcome, String transcriptStatus, String segmentQuality) {
        startTranscription(transcriptionOutcome);
        StageClaim finalized = startFinalization();
        persistTranscript(finalized, transcriptStatus, segmentQuality);
        lifecycle.completeStage(finalized, "SUCCEEDED", null, "{\"persisted\":true}");
        return finalized;
    }

    @Test
    void completedTranscriptionAloneCannotCompleteJob() {
        startTranscription("SUCCEEDED");
        assertThatThrownBy(() -> lifecycle.completeJob(jobId))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThat(jobStatus()).isEqualTo("RUNNING");
    }

    @Test
    void finalizationAndDownstreamStagesRequireUpstreamEvidence() {
        assertThatThrownBy(this::startFinalization).isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThatThrownBy(() -> lifecycle.startStage(jobId, "GENERATING_SUMMARY", null, null))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        startTranscription("SUCCEEDED");
        StageClaim finalization = startFinalization();
        assertThatThrownBy(() -> lifecycle.completeStage(finalization, "SUCCEEDED", null, null))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThat(jdbc.queryForObject("SELECT status FROM processing_stage_runs WHERE id=?",
            String.class, finalization.stageRunId())).isEqualTo("RUNNING");
    }

    @Test
    void persistedFinalizedTranscriptPermitsCompletionAndIdempotentReplay() {
        completedTranscriptStages("SUCCEEDED", "READY", "ACCEPTED");
        lifecycle.completeJob(jobId);
        assertThat(jobStatus()).isEqualTo("COMPLETED");
        Long version = jdbc.queryForObject("SELECT version FROM processing_jobs WHERE id=?",
            Long.class, jobId);
        lifecycle.completeJob(jobId);
        assertThat(jdbc.queryForObject("SELECT version FROM processing_jobs WHERE id=?",
            Long.class, jobId)).isEqualTo(version);
        assertThatThrownBy(() -> lifecycle.startStage(jobId, "INDEXING", null, null))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
    }

    @Test
    void StageWarningsProduceCompletedWithWarningsWithoutCallerChoosingStatus() {
        completedTranscriptStages("SUCCEEDED_WITH_WARNING", "READY", "ACCEPTED");
        lifecycle.completeJob(jobId);
        assertThat(jobStatus()).isEqualTo("COMPLETED_WITH_WARNINGS");
        assertThat(jdbc.queryForObject("SELECT warning_summary FROM processing_jobs WHERE id=?",
            String.class, jobId)).isNotBlank();
    }

    @Test
    void transcriptWarningProducesCompletedWithWarnings() {
        completedTranscriptStages("SUCCEEDED", "READY_WITH_WARNINGS", "SUSPICIOUS");
        lifecycle.completeJob(jobId);
        assertThat(jobStatus()).isEqualTo("COMPLETED_WITH_WARNINGS");
    }

    @Test
    void unacknowledgedQualityWarningsCannotBeLabeledReadyOrCompleted() {
        completedTranscriptStages("SUCCEEDED", "READY", "SUSPICIOUS");
        assertThatThrownBy(() -> lifecycle.completeJob(jobId))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThat(jobStatus()).isEqualTo("RUNNING");
    }

    @Test
    void activeOptionalStagePreventsPrematureCompletion() {
        completedTranscriptStages("SUCCEEDED", "READY", "ACCEPTED");
        StageClaim downstream = lifecycle.startStage(jobId, "GENERATING_SUMMARY", "llm", "summary");
        assertThatThrownBy(() -> lifecycle.completeJob(jobId))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThatThrownBy(() -> lifecycle.completeStage(downstream, "SUCCEEDED", null, "{}"))
            .isInstanceOf(ProcessingLifecycleConflictException.class)
            .hasMessageContaining("canonical acceptance");
        assertThat(jdbc.queryForObject(
            "SELECT status FROM processing_stage_runs WHERE id=?",String.class,
            downstream.stageRunId())).isEqualTo("RUNNING");
        assertThatThrownBy(() -> lifecycle.completeJob(jobId))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThat(jobStatus()).isEqualTo("RUNNING");
    }

    @Test
    void finalJobGuardRejectsForgedOfflineSummarySuccessWithoutCanonicalRow() {
        completedTranscriptStages("SUCCEEDED", "READY", "ACCEPTED");
        StageClaim generated=lifecycle.startStage(jobId,"GENERATING_SUMMARY",null,null);
        jdbc.update("""
            UPDATE processing_stage_runs SET status='SUCCEEDED',completed_at=CURRENT_TIMESTAMP
            WHERE id=?
            """,generated.stageRunId());
        assertThatThrownBy(() -> lifecycle.completeJob(jobId))
            .isInstanceOf(ProcessingLifecycleConflictException.class)
            .hasMessageContaining("canonical acceptance");
        assertThat(jobStatus()).isEqualTo("RUNNING");
    }

    @Test
    void normalOfflineDecisionSuccessRequiresReceiptEvenForZeroCandidates() {
        completedTranscriptStages("SUCCEEDED", "READY", "ACCEPTED");
        StageClaim decisions=lifecycle.startStage(jobId,"EXTRACTING_DECISIONS",null,null);
        assertThatThrownBy(() -> lifecycle.completeStage(decisions,"SUCCEEDED",null,null))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThat(jdbc.queryForObject(
            "SELECT status FROM processing_stage_runs WHERE id=?",String.class,
            decisions.stageRunId())).isEqualTo("RUNNING");
    }

    @Test
    void normalOfflineActionItemStageFailsClosedWithoutOwnerReceipt() {
        completedTranscriptStages("SUCCEEDED", "READY", "ACCEPTED");
        StageClaim action=lifecycle.startStage(jobId,"EXTRACTING_ACTION_ITEMS",null,null);
        assertThatThrownBy(() -> lifecycle.completeStage(action,"SUCCEEDED",null,null))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThat(jdbc.queryForObject(
            "SELECT status FROM processing_stage_runs WHERE id=?",String.class,
            action.stageRunId())).isEqualTo("RUNNING");
    }

    /** Test completion policy with actual PostgreSQL lineage/receipt records. */
    @Test
    void fullOfflineJobWithAcceptedSummaryAndEmptyDecisionBatchCompletes() {
        completedTranscriptStages("SUCCEEDED","READY","ACCEPTED");
        UUID transcript=jdbc.queryForObject(
            "SELECT id FROM transcripts WHERE processing_job_id=?",UUID.class,jobId);
        UUID snapshot=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(
              id,meeting_id,source_media_id,processing_job_id,transcript_id,
              content_revision,sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,0,?,?,100)
            """,snapshot,meetingId,mediaId,jobId,transcript,"a".repeat(64),
            "processing/"+jobId+"/intelligence/source/"+snapshot+".json");

        StageClaim summary=lifecycle.startStage(jobId,"GENERATING_SUMMARY",null,null);
        UUID summaryReceipt=insertIntelligenceReceipt(
            summary.stageRunId(),snapshot,transcript,"SUMMARY");
        jdbc.update("""
            INSERT INTO meeting_summary_versions(
              id,meeting_id,version_number,content,source_type,processing_job_id,
              result_receipt_id,transcript_id,content_revision,quality_status,is_current)
            VALUES (?,?,1,'Persisted summary','AI_GENERATED',?,?,?,0,'READY',TRUE)
            """,UUID.randomUUID(),meetingId,jobId,summaryReceipt,transcript);
        lifecycle.completeStage(summary,"SUCCEEDED",null,null);

        StageClaim decisions=lifecycle.startStage(jobId,"EXTRACTING_DECISIONS",null,null);
        insertIntelligenceReceipt(decisions.stageRunId(),snapshot,transcript,
            "DECISION_EXTRACTION");
        lifecycle.completeStage(decisions,"SUCCEEDED",null,null);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM meeting_decisions WHERE meeting_id=?",
            Integer.class,meetingId)).isZero();

        lifecycle.completeJob(jobId);
        assertThat(jobStatus()).isEqualTo("COMPLETED");
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM meeting_intelligence_result_receipts WHERE processing_job_id=?",
            Integer.class,jobId)).isEqualTo(2);
    }

    private UUID insertIntelligenceReceipt(UUID stageId,UUID snapshot,UUID transcript,
            String type) {
        UUID receipt=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_intelligence_result_receipts(
              id,meeting_id,processing_job_id,stage_run_id,result_type,
              source_snapshot_id,transcript_id,content_revision,artifact_sha256,
              artifact_object_key,artifact_size_bytes)
            VALUES (?,?,?,?,?,?,?,0,?,?,100)
            """,receipt,meetingId,jobId,stageId,type,snapshot,transcript,
            "b".repeat(64),"processing/"+jobId+"/intelligence/results/"+stageId+".json");
        return receipt;
    }

    @Test
    void durableStageMetricsRejectRawAsrTextAndArbitraryProviderPayload() {
        StageClaim stage = lifecycle.startStage(jobId, "TRANSCRIPTION", "whisper", "large-v3");
        assertThatThrownBy(() -> lifecycle.completeStage(stage, "SUCCEEDED", null,
            "{\"rawTranscript\":\"Sensitive raw Whisper candidate text\"}"))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("approved, typed AI diagnostics");
        assertThatThrownBy(() -> lifecycle.completeStage(stage, "SUCCEEDED", null,
            "{\"providerResponse\":{\"text\":\"Sensitive raw data\"}}"))
            .isInstanceOf(IllegalArgumentException.class);
        assertThat(jdbc.queryForObject("SELECT metrics::text FROM processing_stage_runs WHERE id=?",
            String.class, stage.stageRunId())).isNull();
        assertThat(jdbc.queryForObject("SELECT status FROM processing_stage_runs WHERE id=?",
            String.class, stage.stageRunId())).isEqualTo("RUNNING");
        lifecycle.completeStage(stage, "SUCCEEDED", null,
            "{\"validated\":true,\"coverageRatio\":0.92,\"segmentCount\":12}");
        assertThat(jdbc.queryForObject("SELECT metrics->>'segmentCount' FROM processing_stage_runs WHERE id=?",
            String.class, stage.stageRunId())).isEqualTo("12");
    }

    @Test
    void conflictingStageReplayCannotMutateCompletedAttempt() {
        StageClaim stage = startTranscription("SUCCEEDED");
        lifecycle.completeStage(stage, "SUCCEEDED", null, "{\"validated\":true}");
        assertThatThrownBy(() -> lifecycle.completeStage(stage, "SUCCEEDED_WITH_WARNING", null, "{}"))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThatThrownBy(() -> lifecycle.completeStage(stage, "SUCCEEDED", null, "{\"validated\":false}"))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThat(jobStatus()).isEqualTo("RUNNING");
    }

    @Test
    void competingStageStartCannotStealClaimOrBumpJobVersion() {
        StageClaim stage = lifecycle.startStage(jobId, "TRANSCRIPTION", "whisper", "base");
        Long version = jdbc.queryForObject("SELECT version FROM processing_jobs WHERE id=?",
            Long.class, jobId);
        assertThatThrownBy(() -> lifecycle.startStage(jobId, "TRANSCRIPTION", "whisper", "base"))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThat(jdbc.queryForObject("SELECT version FROM processing_jobs WHERE id=?",
            Long.class, jobId)).isEqualTo(version);
        lifecycle.completeStage(stage, "SUCCEEDED", null, null);
        assertThatThrownBy(() -> lifecycle.startStage(jobId, "TRANSCRIPTION", "whisper", "base"))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
    }

    @Test
    void workerRawAsrOrProviderErrorMessageCannotEnterDurableFailureSummary() {
        StageClaim stage = lifecycle.startStage(jobId, "TRANSCRIPTION", "whisper", "large-v3");
        String untrusted = "Raw Whisper candidate: private employee salary and API token\n" + "SECRET_".repeat(200);
        lifecycle.failStage(stage, "ASR_FAILED", untrusted, true);
        String stored = jdbc.queryForObject(
            "SELECT error_summary FROM processing_jobs WHERE id=?", String.class, jobId);
        assertThat(stored).isEqualTo("Audio transcription failed.");
        assertThat(stored).doesNotContain("Whisper", "salary", "API token");
        assertThat(jdbc.queryForObject(
            "SELECT error_code FROM processing_jobs WHERE id=?", String.class, jobId))
            .isEqualTo("ASR_FAILED");
    }

    @Test
    void unknownWorkerFailureCodeUsesNonSensitiveGenericSummary() {
        StageClaim stage = lifecycle.startStage(jobId, "TRANSCRIPTION", "whisper", "large-v3");
        lifecycle.failStage(stage, "UNRECOGNIZED_PROVIDER_FAILURE",
            "private credentials or raw model output", true);
        assertThat(jdbc.queryForObject(
            "SELECT error_summary FROM processing_jobs WHERE id=?", String.class, jobId))
            .isEqualTo("Processing stage failed.");
    }

    @Test
    void failedJobCannotCompleteOrAcceptLateStageSuccess() {
        StageClaim stage = lifecycle.startStage(jobId, "TRANSCRIPTION", "whisper", "base");
        lifecycle.failStage(stage, "ASR_FAILED", "Transcription failed.", true);
        assertThat(jobStatus()).isEqualTo("FAILED");
        assertThatThrownBy(() -> lifecycle.completeJob(jobId)).isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThatThrownBy(() -> lifecycle.completeStage(stage, "SUCCEEDED", null, null))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
    }

    @Test
    void sourceMustRemainAcceptedBeforeStageCanStart() {
        jdbc.update("UPDATE meeting_media SET status='FAILED' WHERE id=?", mediaId);
        assertThatThrownBy(() -> lifecycle.startStage(jobId, "TRANSCRIPTION", null, null))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThat(jobStatus()).isEqualTo("QUEUED");
    }

    @Test
    void suspiciousCoverageCannotBeSilentlyCompletedAsReady() {
        StageClaim finalized = completedTranscriptStages("SUCCEEDED", "READY", "ACCEPTED");
        UUID transcriptId = jdbc.queryForObject("""
            SELECT id FROM transcripts WHERE processing_job_id=? AND source_stage_run_id=?
            """, UUID.class, jobId, finalized.stageRunId());
        jdbc.update("""
            INSERT INTO transcript_coverage_regions(id,transcript_id,start_ms,end_ms,coverage_status)
            VALUES (?,?,500,1000,'UNRESOLVED_ERROR')
            """, UUID.randomUUID(), transcriptId);
        assertThatThrownBy(() -> lifecycle.completeJob(jobId))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
    }
}
