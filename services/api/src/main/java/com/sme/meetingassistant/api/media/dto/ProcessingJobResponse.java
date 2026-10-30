package com.sme.meetingassistant.api.media.dto;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

public record ProcessingJobResponse(UUID id, UUID meetingId, UUID sourceMediaId, String jobType,
        String status, UUID requestedByUserId, String currentStage, OffsetDateTime queuedAt,
        OffsetDateTime startedAt, OffsetDateTime completedAt, String errorCode, String errorSummary,
        String warningSummary, OffsetDateTime createdAt, OffsetDateTime updatedAt,
        UUID reprocessOfJobId, boolean retryable, int retryCount, List<ProcessingStageResponse> stageRuns) { }
