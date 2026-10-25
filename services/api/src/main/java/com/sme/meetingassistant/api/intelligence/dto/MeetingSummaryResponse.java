package com.sme.meetingassistant.api.intelligence.dto;

import com.sme.meetingassistant.api.intelligence.entity.MeetingSummaryEntity;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

public record MeetingSummaryResponse(UUID id, UUID meetingId, UUID sourceTranscriptId, int versionNumber,
		String title, String overview, List<String> keyPoints, boolean current, OffsetDateTime createdAt,
		List<MeetingDecisionResponse> decisions) {

	public MeetingSummaryResponse {
		keyPoints = List.copyOf(keyPoints);
		decisions = List.copyOf(decisions);
	}

	public static MeetingSummaryResponse from(MeetingSummaryEntity entity, List<MeetingDecisionResponse> decisions) {
		return new MeetingSummaryResponse(entity.getId(), entity.getMeetingId(), entity.getSourceTranscriptId(),
				entity.getVersionNumber(), entity.getTitle(), entity.getOverview(), entity.getKeyPoints(),
				entity.isCurrent(), entity.getCreatedAt(), decisions);
	}

}
