package com.sme.meetingassistant.api.media.service;

import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.common.SafeAiDiagnostics;
import com.sme.meetingassistant.api.common.SafeProcessingFailureSummary;
import com.sme.meetingassistant.api.media.repository.MediaRepository.ProcessingLifecycleConflictException;
import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import org.springframework.scheduling.annotation.Scheduled;
import java.util.UUID;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;

@Service
public class ProcessingJobLifecycleService implements ProcessingJobLifecycle {
    private final MediaRepository repository;
    private final ObjectMapper mapper;
    private final MediaProperties properties;
    private final ProcessingTranscriptEvidence transcriptEvidence;

    public ProcessingJobLifecycleService(MediaRepository repository, ObjectMapper mapper,
            MediaProperties properties, ProcessingTranscriptEvidence transcriptEvidence) {
        this.repository = repository;
        this.mapper = mapper;
        this.properties = properties;
        this.transcriptEvidence = transcriptEvidence;
    }

    private int leaseSeconds() {
        int value = this.properties.getProcessing().getStageLeaseSeconds();
        if (value < 30) throw new IllegalStateException("Stage lease must be at least 30 seconds.");
        return value;
    }

    @Scheduled(fixedDelayString = "${app.media.processing.stage-lease-sweep-ms:60000}")
    @Transactional
    public void expireAbandonedStages() {
        this.repository.expireAbandonedStages(25);
    }

    @Override
    @Transactional
    public StageClaim startStage(UUID jobId, String stageCode, String providerName, String modelName) {
        requireCode(stageCode, 48, "stageCode");
        requireOptionalText(providerName, 80, "providerName");
        requireOptionalText(modelName, 160, "modelName");
        if (List.of("GENERATING_SUMMARY", "EXTRACTING_DECISIONS",
                "EXTRACTING_ACTION_ITEMS", "INDEXING").contains(stageCode)
                && !this.transcriptEvidence.hasFinalizedTranscript(jobId)) {
            throw new ProcessingLifecycleConflictException("Downstream processing requires a persisted finalized transcript.");
        }
        return this.repository.startStage(jobId, stageCode, providerName, modelName, leaseSeconds());
    }

    @Override
    @Transactional
    public void renewStageLease(StageClaim claim) {
        requireClaim(claim);
        this.repository.renewStageLease(claim, leaseSeconds());
    }

    @Override
    @Transactional
    public void completeStage(StageClaim claim, String outcome, String errorCode, String metricsJson) {
        requireClaim(claim);
        if (!"SUCCEEDED".equals(outcome) && !"SUCCEEDED_WITH_WARNING".equals(outcome)) {
            throw new IllegalArgumentException("Stage outcome must be successful.");
        }
        requireOptionalText(errorCode, 96, "errorCode");
        if (metricsJson != null) {
            try {
                if (!this.mapper.readTree(metricsJson).isObject()) {
                    throw new IllegalArgumentException("Stage metrics must be a JSON object.");
                }
                @SuppressWarnings("unchecked")
                Map<String, Object> metadata = (Map<String, Object>) this.mapper.readValue(metricsJson, Map.class);
                SafeAiDiagnostics.stageMetrics(metadata);
            } catch (JacksonException invalidJson) {
                throw new IllegalArgumentException("Stage metrics must be valid JSON.", invalidJson);
            }
        }
        var identity = this.repository.stageIdentity(claim.stageRunId());
        if ("FINALIZING_TRANSCRIPT".equals(identity.stageCode())
                && this.transcriptEvidence.forFinalization(identity.jobId(), claim.stageRunId()).isEmpty()) {
            throw new ProcessingLifecycleConflictException("Canonical transcript must exist before stage success.");
        }
        this.repository.completeStage(claim, outcome, errorCode, metricsJson);
    }

    @Override
    @Transactional
    public void failStage(StageClaim claim, String errorCode, String untrustedWorkerSummary, boolean retryable) {
        requireClaim(claim);
        requireCode(errorCode, 96, "errorCode");
        // The worker/provider summary is untrusted and may contain raw ASR text,
        // provider payloads or credentials. Never persist it as business state.
        this.repository.failStage(claim, errorCode,
            SafeProcessingFailureSummary.forCode(errorCode), retryable);
    }

    @Override
    @Transactional(readOnly = true)
    public boolean hasPendingPipelineStages(UUID jobId) {
        return this.repository.hasPendingPipelineStages(jobId);
    }

    @Override
    @Transactional
    public void completeJob(UUID jobId) {
        this.repository.completeJob(jobId, this.transcriptEvidence.latestSuccessfulFinalization(jobId).orElse(null));
    }

    @Override
    @Transactional
    public boolean requireFinalizationClaim(UUID jobId, UUID meetingId, UUID mediaId, StageClaim claim) {
        return this.repository.requireFinalizationClaim(jobId, meetingId, mediaId, claim);
    }

    @Override
    @Transactional
    public void recordArtifact(UUID jobId, StageClaim claim, String artifactType, String objectKey,
            String sha256, Long sizeBytes, String retentionClass) {
        recordBinaryArtifact(jobId, claim, false, artifactType, objectKey, sha256,
            sizeBytes, retentionClass);
    }

    @Override
    @Transactional
    public void recordJobArtifact(UUID jobId, StageClaim producerClaim, String artifactType,
            String objectKey, String sha256, Long sizeBytes, String retentionClass) {
        recordBinaryArtifact(jobId, producerClaim, true, artifactType, objectKey, sha256,
            sizeBytes, retentionClass);
    }

    private void recordBinaryArtifact(UUID jobId, StageClaim claim, boolean jobScoped,
            String artifactType, String objectKey, String sha256, Long sizeBytes,
            String retentionClass) {
        requireClaim(claim);
        if (jobId == null) throw new IllegalArgumentException("jobId is required.");
        if (!"NORMALIZED_AUDIO".equals(artifactType) && !"AUDIO_CHUNK".equals(artifactType)) {
            // Raw ASR/Whisper text and unvalidated debug JSON are never durable artifacts.
            throw new IllegalArgumentException("Only approved non-text audio artifacts are allowed.");
        }
        if (sha256 == null || !sha256.matches("[0-9a-fA-F]{64}")) {
            throw new IllegalArgumentException("Artifact sha256 is required.");
        }
        if (sizeBytes == null || sizeBytes <= 0) {
            throw new IllegalArgumentException("Artifact sizeBytes must be positive.");
        }
        if (retentionClass != null && !"TEMPORARY".equals(retentionClass)
                && !"STANDARD".equals(retentionClass)) {
            throw new IllegalArgumentException("Invalid artifact retentionClass.");
        }
        String prefix = "processing/" + jobId + "/artifacts/";
        if (objectKey == null || !objectKey.startsWith(prefix)) {
            throw new IllegalArgumentException("Artifact must belong to its processing job namespace.");
        }
        String basename = objectKey.substring(prefix.length());
        if (!basename.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(wav|flac|pcm)")) {
            throw new IllegalArgumentException("Artifact object key must use a generated binary-audio identifier.");
        }
        this.repository.recordArtifact(jobId, claim, jobScoped, artifactType, objectKey,
            sha256.toLowerCase(java.util.Locale.ROOT), sizeBytes, retentionClass);
    }

    private static void requireClaim(StageClaim claim) {
        if (claim == null || claim.stageRunId() == null || claim.claimToken() == null) {
            throw new IllegalArgumentException("Stage claim is required.");
        }
    }

    private static void requireCode(String value, int max, String field) {
        if (value == null || !value.matches("[A-Z][A-Z0-9_]{0," + (max - 1) + "}")) {
            throw new IllegalArgumentException(field + " has an invalid code format.");
        }
    }

    private static void requireOptionalText(String value, int max, String field) {
        if (value != null && (value.length() > max || hasControls(value))) {
            throw new IllegalArgumentException(field + " is invalid.");
        }
    }

    private static boolean hasControls(String value) {
        return value.chars().anyMatch(Character::isISOControl);
    }
}
