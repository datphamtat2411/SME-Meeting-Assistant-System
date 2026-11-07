package com.sme.meetingassistant.api.media.service;

import java.util.Optional;
import java.util.UUID;

/**
 * Consumer-owned application port. Media needs canonical transcript evidence but
 * must not query or depend directly on Transcript's private persistence schema.
 * The Transcript module implements this port inside the same database transaction.
 */
public interface ProcessingTranscriptEvidence {
    record Evidence(UUID finalizationStageId, String status, boolean suspicious) {}

    /** Identity-only publication evidence; no transcript text or storage capability. */
    record DiarizationSource(UUID transcriptId, UUID finalizationStageId,
            long contentRevision, boolean current) {}

    /** Serialize source reads with publication and human review, before taking the Job lock. */
    void lockDiarizationSource(UUID jobId);

    Optional<DiarizationSource> diarizationSource(UUID jobId);

    Optional<Evidence> forFinalization(UUID processingJobId, UUID finalizationStageRunId);

    /** Latest successful finalization stage must have canonical transcript evidence. */
    Optional<Evidence> latestSuccessfulFinalization(UUID processingJobId);

    default boolean hasFinalizedTranscript(UUID jobId) {
        return latestSuccessfulFinalization(jobId).isPresent();
    }
}
