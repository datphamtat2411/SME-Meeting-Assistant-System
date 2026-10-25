package com.sme.meetingassistant.api.media.dto;

import com.sme.meetingassistant.api.media.entity.ProcessingJobAttemptEntity;
import java.time.OffsetDateTime;
import java.util.UUID;

public record ProcessingJobAttemptResponse(UUID id, int attemptNumber, String status, String failureCode,
        OffsetDateTime startedAt, OffsetDateTime finishedAt) {

    public static ProcessingJobAttemptResponse from(ProcessingJobAttemptEntity attempt) {
        return new ProcessingJobAttemptResponse(attempt.getId(), attempt.getAttemptNumber(),
                attempt.getStatus().name(), attempt.getFailureCode(), attempt.getStartedAt(), attempt.getFinishedAt());
    }
}
