package com.sme.meetingassistant.api.media.diarization;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.verifyNoInteractions;

import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink;
import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink.Candidate;
import com.sme.meetingassistant.api.media.repository.MediaRepository.ProcessingLifecycleConflictException;
import com.sme.meetingassistant.api.meetingintelligence.service.ActionItemProposalHandoff;
import com.sme.meetingassistant.api.meetingintelligence.service.ActionItemProposalHandoff.SourceReference;
import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.TestPropertySource;

/**
 * MERGE-05: real Core Media, Transcript, MI handoff and Action Items sink share
 * one job and one PostgreSQL history. Only the external diarization object
 * store is mocked by the base fixture. Business notification gates remain off.
 */
@TestPropertySource(properties = "app.media.processing.action-item-handoff-enabled=true")
class DiarizationCrossModuleCompatibilityIntegrationTests extends DiarizationIntegrationFixture {
    @Autowired ActionItemProposalHandoff handoff;
    @Autowired ActionItemProposalSink proposals;
    @Autowired TranscriptRepository transcripts;

    private UUID sourceSnapshot;
    private UUID decision;
    private UUID segment;
    private UUID extractionStage;

    @BeforeEach
    void pinBusinessSourceBeforeDiarization() {
        sourceSnapshot = UUID.randomUUID();
        decision = UUID.randomUUID();
        segment = jdbc.queryForObject(
            "SELECT id FROM transcript_segments WHERE transcript_id=? AND ordinal=7", UUID.class, transcript);
        extractionStage = UUID.randomUUID();

        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(
                id,meeting_id,source_media_id,processing_job_id,transcript_id,
                content_revision,sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,0,?,?,512)
            """, sourceSnapshot, meeting, media, job, transcript, "b".repeat(64),
            "processing/" + job + "/intelligence/source/" + sourceSnapshot + ".json");
        jdbc.update("""
            INSERT INTO meeting_decisions(id,meeting_id,content,status,source_type,created_by_user_id)
            VALUES (?,?,'Already accepted business context','PROPOSED','MANUAL',?)
            """, decision, meeting, actor);
        jdbc.update("""
            INSERT INTO user_preferences(user_id,timezone,locale,meeting_email_enabled,action_item_email_enabled)
            VALUES (?,'Asia/Ho_Chi_Minh','vi',false,false)
            """, actor);
        // Keep the job active after optional completion so downstream admission
        // occurs on the same canonical job, never a synthetic separate job.
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'EXTRACTING_ACTION_ITEMS',1,'PENDING')
            """, extractionStage, job);
    }

    private String jobStatus() {
        return jdbc.queryForObject("SELECT status FROM processing_jobs WHERE id=?", String.class, job);
    }

    private long revision() {
        return jdbc.queryForObject("SELECT content_revision FROM transcripts WHERE id=?", Long.class, transcript);
    }

    private String segmentText() {
        return jdbc.queryForObject("SELECT current_text FROM transcript_segments WHERE id=?", String.class, segment);
    }

    private void assertPinnedBusinessDataUnchanged() {
        assertThat(jdbc.queryForMap("""
            SELECT processing_job_id,transcript_id,content_revision,sha256,size_bytes
            FROM meeting_intelligence_source_snapshots WHERE id=?
            """, sourceSnapshot))
            .containsEntry("processing_job_id", job)
            .containsEntry("transcript_id", transcript)
            .containsEntry("content_revision", 0L)
            .containsEntry("sha256", "b".repeat(64))
            .containsEntry("size_bytes", 512L);
        assertThat(jdbc.queryForObject(
            "SELECT content FROM meeting_decisions WHERE id=?", String.class, decision))
            .isEqualTo("Already accepted business context");
        assertThat(jdbc.queryForObject(
            "SELECT meeting_email_enabled FROM user_preferences WHERE user_id=?",
            Boolean.class, actor)).isFalse();
        assertThat(jdbc.queryForObject(
            "SELECT action_item_email_enabled FROM user_preferences WHERE user_id=?",
            Boolean.class, actor)).isFalse();
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM meeting_intelligence_source_snapshots WHERE processing_job_id=?",
            Long.class, job)).isEqualTo(1L);
    }

    private UUID extractOfficialProposal(boolean expectedStale) {
        var stageClaim = lifecycle.startStage(job, "EXTRACTING_ACTION_ITEMS", null, null);
        assertThat(stageClaim.stageRunId()).isEqualTo(extractionStage);
        assertThat(handoff.handoff(stageClaim,
            new SourceReference(sourceSnapshot, transcript, 0L, "b".repeat(64)),
            List.of(new Candidate("forecast", "Submit quarterly report",
                "Human-reviewable proposal only", LocalDate.of(2026, 11, 9), List.of(segment)))))
            .isEqualTo(new ActionItemProposalSink.Receipt(false, 1));

        assertThat(proposals.hasAcceptedBatch(job, extractionStage)).isTrue();
        assertThat(jdbc.queryForObject("""
            SELECT is_stale FROM action_item_batch_receipts
            WHERE processing_job_id=? AND stage_run_id=?
            """, Boolean.class, job, extractionStage)).isEqualTo(expectedStale);

        UUID item = jdbc.queryForObject("""
            SELECT id FROM action_items WHERE processing_job_id=? AND source_type='AI_EXTRACTED'
            """, UUID.class, job);
        assertThat(jdbc.queryForMap("""
            SELECT source_type,status,assignee_user_id,content_revision
            FROM action_items WHERE id=?
            """, item))
            .containsEntry("source_type", "AI_EXTRACTED")
            .containsEntry("status", "PROPOSED")
            .containsEntry("assignee_user_id", null)
            .containsEntry("content_revision", 0L);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM action_item_evidence
            WHERE action_item_id=? AND transcript_id=? AND transcript_segment_id=?
            """, Long.class, item, transcript, segment)).isEqualTo(1L);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM action_item_assignment_events WHERE action_item_id=?
            """, Long.class, item)).isZero();
        assertThat(jdbc.queryForObject("""
            SELECT status FROM processing_stage_runs WHERE id=?
            """, String.class, extractionStage)).isEqualTo("SUCCEEDED");
        return item;
    }

    @Test
    void optionalDiarizationFailureDoesNotBlockRealActionItemHandoffOrMutateTranscript() {
        assertThatThrownBy(() -> lifecycle.startStage(job, "EXTRACTING_ACTION_ITEMS", null, null))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        claim();
        var failure = new DiarizationCommands.Fail(UUID.randomUUID(), owner, "INFERENCE", "TIMEOUT");
        assertThat(worker.fail(job, failure).get("state")).isEqualTo("FAILURE_RECORDED");
        assertThat(worker.fail(job, failure).get("state")).isEqualTo("FAILURE_RECORDED");

        assertThat(stageStatus()).isEqualTo("FAILED");
        assertThat(jobStatus()).isEqualTo("RUNNING");
        assertThat(revision()).isZero();
        assertThat(segmentText()).isEqualTo("PRIVATE CORRECTED TEXT");
        assertThat(jdbc.queryForObject(
            "SELECT status FROM transcripts WHERE id=?", String.class, transcript)).isEqualTo("READY");
        assertThat(count("diarization_worker_receipts")).isEqualTo(1L);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM speaker_clusters WHERE transcript_id=?", Long.class, transcript)).isZero();

        extractOfficialProposal(false);
        assertPinnedBusinessDataUnchanged();
        lifecycle.completeJob(job);
        assertThat(jobStatus()).isEqualTo("COMPLETED_WITH_WARNINGS");
        assertPinnedBusinessDataUnchanged();
    }

    @Test
    void successfulSpeakerProjectionKeepsPinnedMiEvidenceAndNeverAutoAssignsActionItems() throws Exception {
        claim();
        var completed = upload(artifact());
        assertThat(completion.complete(job, completed).get("state")).isEqualTo("RESULT_ACCEPTED");
        assertThat(revision()).isEqualTo(1L);
        assertThat(segmentText()).isEqualTo("PRIVATE CORRECTED TEXT");

        // The pinned MI source still points to the pre-diarization transcript
        // revision. The real Action Items sink must mark its proposal stale;
        // changing speaker labels must never promote it to an official task.
        UUID item = extractOfficialProposal(true);
        assertPinnedBusinessDataUnchanged();

        UUID speaker = jdbc.queryForObject(
            "SELECT speaker_cluster_id FROM transcript_segments WHERE id=?", UUID.class, segment);
        transactions.executeWithoutResult(tx -> {
            transcripts.correct(meeting, segment, actor, "Human correction after inference", "Review", 1);
            transcripts.mapSpeaker(meeting, speaker, actor, actor, transcript, 2);
        });
        assertThat(revision()).isEqualTo(3L);
        var before = jdbc.queryForList(
            "SELECT * FROM transcript_segments WHERE transcript_id=?", transcript);
        expire();
        clearInvocations(storage);
        assertThat(completion.complete(job, completed).get("state")).isEqualTo("RESULT_ACCEPTED");
        verifyNoInteractions(storage);
        assertThat(jdbc.queryForList(
            "SELECT * FROM transcript_segments WHERE transcript_id=?", transcript)).isEqualTo(before);
        assertThat(segmentText()).isEqualTo("Human correction after inference");
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM speaker_mappings WHERE speaker_cluster_id=? AND superseded_at IS NULL
            """, Long.class, speaker)).isEqualTo(1L);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM action_item_batch_receipts WHERE processing_job_id=?",
            Long.class, job)).isEqualTo(1L);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM action_item_assignment_events WHERE action_item_id=?",
            Long.class, item)).isZero();
        assertThat(count("diarization_acceptance_measurements")).isEqualTo(1L);
        assertPinnedBusinessDataUnchanged();
    }

    @Test
    void diarizationRetryAfterHumanCorrectionPreservesOldMiLineageAndAsrHistory() throws Exception {
        claim();
        assertThat(worker.fail(job,
            new DiarizationCommands.Fail(UUID.randomUUID(), owner, "INFERENCE", "TIMEOUT"))
            .get("state")).isEqualTo("FAILURE_RECORDED");
        transactions.executeWithoutResult(tx -> transcripts.correct(meeting, segment, actor,
            "Human reviewed before retry", "Review", 0));
        assertThat(revision()).isEqualTo(1L);
        assertThat(segmentText()).isEqualTo("Human reviewed before retry");

        transactions.executeWithoutResult(tx -> {
            transcriptEvidence.lockDiarizationSource(job);
            assertThat(mediaRepository.retryDiarizationAndOutbox(
                mediaRepository.findJob(job).orElseThrow(),
                transcriptEvidence.diarizationSource(job).orElseThrow(), 2)).isTrue();
        });
        stage = jdbc.queryForObject("""
            SELECT id FROM processing_stage_runs WHERE processing_job_id=?
              AND stage_code='DIARIZING' AND attempt_number=2
            """, UUID.class, job);
        event = jdbc.queryForObject(
            "SELECT event_id FROM processing_diarization_dispatches WHERE stage_run_id=?",
            UUID.class, stage);
        request = new DiarizationCommands.Claim(event, "PROCESSING_DIARIZATION_REQUESTED",
            1, meeting, media, stage, UUID.randomUUID());

        claim();
        assertThat(completion.complete(job, upload(artifact().put("transcriptRevision", 1)))
            .get("state")).isEqualTo("RESULT_ACCEPTED");
        assertThat(revision()).isEqualTo(2L);
        assertThat(segmentText()).isEqualTo("Human reviewed before retry");
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM transcript_segment_revisions WHERE segment_id=?",
            Long.class, segment)).isEqualTo(1L);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM processing_stage_runs WHERE processing_job_id=?
              AND stage_code IN ('TRANSCRIPTION','CONTEXTUAL_CORRECTION','FINALIZING_TRANSCRIPT')
            """, Long.class, job)).isEqualTo(3L);
        assertThat(count("diarization_worker_receipts")).isEqualTo(2L);

        extractOfficialProposal(true);
        assertPinnedBusinessDataUnchanged();
    }
}
