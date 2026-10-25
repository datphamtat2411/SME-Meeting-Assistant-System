package com.sme.meetingassistant.api.media.dto;

import com.sme.meetingassistant.api.media.entity.ProcessingArtifactEntity;
import java.time.OffsetDateTime;
import java.util.UUID;

public record ProcessingArtifactResponse(UUID id, UUID jobId, UUID attemptId, String artifactType, String fileName,
        String contentType, long sizeBytes, String checksum, OffsetDateTime createdAt) {

    public static ProcessingArtifactResponse from(ProcessingArtifactEntity artifact) {
        return new ProcessingArtifactResponse(artifact.getId(), artifact.getJobId(), artifact.getAttemptId(),
                artifact.getArtifactType(), artifact.getFileName(), artifact.getContentType(), artifact.getSizeBytes(),
                artifact.getChecksum(), artifact.getCreatedAt());
    }
}
