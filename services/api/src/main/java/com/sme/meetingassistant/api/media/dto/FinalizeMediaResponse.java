package com.sme.meetingassistant.api.media.dto;

import java.time.OffsetDateTime;
import java.util.UUID;

public record FinalizeMediaResponse(UUID id, UUID meetingId, String sourceType, String status,
        String originalFilename, String contentType, Long sizeBytes, Long durationMs, String sha256,
        OffsetDateTime createdAt, OffsetDateTime availableAt, String failureCode) { }
