package com.sme.meetingassistant.api.media.service;

import java.util.UUID;

/**
 * Internal application boundary for authenticated processing-worker adapters.
 * This contract is intentionally not exposed as a public HTTP API.
 */
public interface ProcessingJobLifecycle {
    /** One durable stage attempt with an unguessable owner token; never expose to clients. */
    record StageClaim(UUID stageRunId, UUID claimToken) { }

    StageClaim startStage(UUID jobId, String stageCode, String providerName, String modelName);

    void renewStageLease(StageClaim claim);

    void completeStage(StageClaim claim, String outcome, String errorCode, String metricsJson);

    void failStage(StageClaim claim, String errorCode, String safeSummary, boolean retryable);

    void completeJob(UUID jobId);

    void recordArtifact(UUID jobId, StageClaim claim, String artifactType, String objectKey,
            String sha256, Long sizeBytes, String retentionClass);
}
