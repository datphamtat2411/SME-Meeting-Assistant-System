package com.sme.meetingassistant.api.media.service;

import java.util.UUID;

/**
 * Internal application boundary for authenticated processing-worker adapters.
 * This contract is intentionally not exposed as a public HTTP API.
 */
public interface ProcessingJobLifecycle {
    /** One durable stage attempt with an unguessable owner token; never expose to clients. */
    record StageClaim(UUID stageRunId, UUID claimToken) { }

    /** Trusted, server-resolved identity for a derived-stage attempt. */
    record DerivedStage(UUID jobId, UUID meetingId, UUID sourceMediaId, String stageCode) { }

    DerivedStage derivedStage(UUID stageRunId);

    StageClaim startStage(UUID jobId, String stageCode, String providerName, String modelName);

    void renewStageLease(StageClaim claim);

    void completeStage(StageClaim claim, String outcome, String errorCode, String metricsJson);

    /** Worker failure details are untrusted and ignored; Core derives safe summaries from errorCode. */
    void failStage(StageClaim claim, String errorCode, String untrustedWorkerSummary, boolean retryable);

    void completeJob(UUID jobId);

    /** Admit only a currently claimed finalization attempt for matching source media. */
    boolean requireFinalizationClaim(UUID jobId, UUID meetingId, UUID mediaId, StageClaim claim);

    /** True while this job has preplanned downstream work not yet started. */
    boolean hasPendingPipelineStages(UUID jobId);

    /**
     * Stage-scoped intermediate binary. Claim is required for producer ownership.
     */
    void recordArtifact(UUID jobId, StageClaim claim, String artifactType, String objectKey,
            String sha256, Long sizeBytes, String retentionClass);

    /**
     * Job-scoped intermediate binary with no stage_run_id. Still fenced by
     * its producing stage's active claim; nullable provenance is not unauthenticated.
     */
    void recordJobArtifact(UUID jobId, StageClaim producerClaim, String artifactType,
            String objectKey, String sha256, Long sizeBytes, String retentionClass);
}
