package com.sme.meetingassistant.api.transcript.dto;

import com.sme.meetingassistant.api.transcript.entity.TranscriptEntity;
import java.time.OffsetDateTime;
import java.util.UUID;

public record TranscriptVersionResponse(UUID id, int versionNumber, UUID sourceProcessingJobId, String language,
		boolean current, OffsetDateTime createdAt, OffsetDateTime updatedAt) {

	public static TranscriptVersionResponse from(TranscriptEntity transcript) {
		return new TranscriptVersionResponse(transcript.getId(), transcript.getVersionNumber(),
				transcript.getSourceProcessingJobId(), transcript.getLanguage(), transcript.isCurrent(),
				transcript.getCreatedAt(), transcript.getUpdatedAt());
	}

}
