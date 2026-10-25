package com.sme.meetingassistant.api.media.dto;

import com.sme.meetingassistant.api.media.entity.ProcessingJobEntity;
import java.time.OffsetDateTime;
import java.util.UUID;

public record ProcessingJobResponse(UUID id, UUID mediaId, String status, int attemptCount, int maxAttempts,
		String failureCode, OffsetDateTime nextAttemptAt, UUID parentJobId, String requestType,
		OffsetDateTime createdAt, OffsetDateTime updatedAt, OffsetDateTime startedAt, OffsetDateTime finishedAt) {

	public static ProcessingJobResponse from(ProcessingJobEntity job) {
		return new ProcessingJobResponse(job.getId(), job.getMediaId(), job.getStatus().name(), job.getAttemptCount(),
				job.getMaxAttempts(), job.getFailureCode(), job.getNextAttemptAt(), job.getParentJobId(),
				job.getRequestType().name(), job.getCreatedAt(), job.getUpdatedAt(), job.getStartedAt(), job.getFinishedAt());
	}

}
