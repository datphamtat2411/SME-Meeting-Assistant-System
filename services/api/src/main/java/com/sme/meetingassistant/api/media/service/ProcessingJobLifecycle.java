package com.sme.meetingassistant.api.media.service;

import java.util.UUID;

/**
 * Internal application boundary for authenticated processing-worker adapters.
 * This contract is intentionally not exposed as a public HTTP API.
 */
public interface ProcessingJobLifecycle {
    UUID startStage(UUID jobId, String stageCode, String providerName, String modelName);

    void completeStage(UUID stageRunId, String outcome, String errorCode, String metricsJson);

    void failStage(UUID stageRunId, String errorCode, String safeSummary, boolean retryable);

    void completeJob(UUID jobId);

    void recordArtifact(UUID jobId, UUID stageRunId, String artifactType, String objectKey,
            String sha256, Long sizeBytes, String retentionClass);
}
