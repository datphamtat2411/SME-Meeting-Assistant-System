package com.sme.meetingassistant.api.integration;

import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.TranscriptResult;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Single local PostgreSQL transaction joining the media lifecycle and
 * canonical transcript persistence. No cross-module repository coupling.
 *
 * Worker adapter owns the stage claim and calls this after the AI result has
 * passed source-audio validation and LLM correction. A duplicate call with
 * the same result is a replay, never another transcript version.
 */
@Service
public class TranscriptFinalizationService {
    private final TranscriptRepository transcripts;
    private final ProcessingJobLifecycle lifecycle;

    public TranscriptFinalizationService(TranscriptRepository transcripts,
            ProcessingJobLifecycle lifecycle) {
        this.transcripts = transcripts;
        this.lifecycle = lifecycle;
    }

    @Transactional
    public void finalizeTranscript(StageClaim claim, TranscriptResult result) {
        if (claim == null || claim.stageRunId() == null || claim.claimToken() == null
                || result == null || result.meetingId() == null
                || result.sourceMediaId() == null || result.processingJobId() == null
                || !claim.stageRunId().equals(result.sourceStageRunId())
                || result.status() == null) {
            throw new IllegalArgumentException("Transcript result and finalization claim must match.");
        }
        // One lock order for promotion, human review and job finalization.
        transcripts.lockMeetingForReview(result.meetingId());
        boolean completed = lifecycle.requireFinalizationClaim(result.processingJobId(),
            result.meetingId(), result.sourceMediaId(), claim);
        if (completed) {
            // A completed retry must be byte-for-byte (semantically) identical;
            // the existing publication identity check rejects conflicting payloads.
            transcripts.publish(result);
            return;
        }

        // All writes participate in this method's transaction. Any exception
        // rolls back transcript rows, stage success and job completion together.
        transcripts.publishDuringFinalization(result);
        String stageOutcome = result.status() == TranscriptIngestion.Status.READY_WITH_WARNINGS
            ? "SUCCEEDED_WITH_WARNING" : "SUCCEEDED";
        lifecycle.completeStage(claim, stageOutcome, null, null);
        // The transcript milestone is not the completion of a full meeting pipeline.
        // Preplanned downstream stages continue under the same processing job.
        if (!lifecycle.hasPendingPipelineStages(result.processingJobId())) {
            lifecycle.completeJob(result.processingJobId());
        }
    }
}
