package com.sme.meetingassistant.api.transcript.dto;

import com.sme.meetingassistant.api.transcript.entity.TranscriptEntity;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

public record TranscriptResponse(UUID id, UUID meetingId, int versionNumber, UUID sourceProcessingJobId,
		String language, boolean current, long concurrencyVersion, OffsetDateTime createdAt, OffsetDateTime updatedAt,
		List<TranscriptSegmentResponse> segments) {

	public static TranscriptResponse from(TranscriptEntity transcript, List<TranscriptSegmentResponse> segments) {
		return new TranscriptResponse(transcript.getId(), transcript.getMeetingId(), transcript.getVersionNumber(),
				transcript.getSourceProcessingJobId(), transcript.getLanguage(), transcript.isCurrent(),
					transcript.getConcurrencyVersion(), transcript.getCreatedAt(), transcript.getUpdatedAt(), List.copyOf(segments));
	}

}
