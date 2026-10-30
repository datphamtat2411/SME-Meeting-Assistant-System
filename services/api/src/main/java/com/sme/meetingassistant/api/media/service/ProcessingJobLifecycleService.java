package com.sme.meetingassistant.api.media.service;

import com.sme.meetingassistant.api.media.repository.MediaRepository;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;

@Service
public class ProcessingJobLifecycleService implements ProcessingJobLifecycle {
    private final MediaRepository repository;
    private final ObjectMapper mapper;

    public ProcessingJobLifecycleService(MediaRepository repository, ObjectMapper mapper) {
        this.repository = repository;
        this.mapper = mapper;
    }

    @Override
    @Transactional
    public UUID startStage(UUID jobId, String stageCode, String providerName, String modelName) {
        requireCode(stageCode, 48, "stageCode");
        requireOptionalText(providerName, 80, "providerName");
        requireOptionalText(modelName, 160, "modelName");
        return this.repository.startStage(jobId, stageCode, providerName, modelName);
    }

    @Override
    @Transactional
    public void completeStage(UUID stageRunId, String outcome, String errorCode, String metricsJson) {
        if (!"SUCCEEDED".equals(outcome) && !"SUCCEEDED_WITH_WARNING".equals(outcome)) {
            throw new IllegalArgumentException("Stage outcome must be successful.");
        }
        requireOptionalText(errorCode, 96, "errorCode");
        if (metricsJson != null) {
            try {
                if (!this.mapper.readTree(metricsJson).isObject()) {
                    throw new IllegalArgumentException("Stage metrics must be a JSON object.");
                }
            } catch (JacksonException invalidJson) {
                throw new IllegalArgumentException("Stage metrics must be valid JSON.", invalidJson);
            }
        }
        this.repository.completeStage(stageRunId, outcome, errorCode, metricsJson);
    }

    @Override
    @Transactional
    public void failStage(UUID stageRunId, String errorCode, String safeSummary, boolean retryable) {
        requireCode(errorCode, 96, "errorCode");
        requireRequiredText(safeSummary, 1000, "safeSummary");
        this.repository.failStage(stageRunId, errorCode, safeSummary, retryable);
    }

    @Override
    @Transactional
    public void completeJob(UUID jobId) {
        this.repository.completeJob(jobId);
    }

    @Override
    @Transactional
    public void recordArtifact(UUID jobId, UUID stageRunId, String artifactType, String objectKey,
            String sha256, Long sizeBytes, String retentionClass) {
        requireCode(artifactType, 64, "artifactType");
        requireRequiredText(objectKey, 2048, "objectKey");
        requireOptionalText(sha256, 64, "sha256");
        requireOptionalText(retentionClass, 32, "retentionClass");
        if (sha256 != null && !sha256.matches("[0-9a-fA-F]{64}")) {
            throw new IllegalArgumentException("sha256 must contain 64 hexadecimal characters.");
        }
        if (sizeBytes != null && sizeBytes < 0) throw new IllegalArgumentException("sizeBytes cannot be negative.");
        this.repository.recordArtifact(jobId, stageRunId, artifactType, objectKey,
            sha256, sizeBytes, retentionClass);
    }

    private static void requireCode(String value, int max, String field) {
        if (value == null || !value.matches("[A-Z][A-Z0-9_]{0," + (max - 1) + "}")) {
            throw new IllegalArgumentException(field + " has an invalid code format.");
        }
    }

    private static void requireRequiredText(String value, int max, String field) {
        if (value == null || value.isBlank() || value.length() > max || hasControls(value)) {
            throw new IllegalArgumentException(field + " is invalid.");
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
