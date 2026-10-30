package com.sme.meetingassistant.api.media.dto;

import java.time.OffsetDateTime;
import java.util.UUID;

public record ProcessingStageResponse(UUID id, String stageCode, int attemptNumber, String status,
        String providerName, String modelName, OffsetDateTime startedAt, OffsetDateTime completedAt,
        String errorCode) { }
