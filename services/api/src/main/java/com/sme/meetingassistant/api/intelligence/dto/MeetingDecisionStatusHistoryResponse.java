package com.sme.meetingassistant.api.intelligence.dto;

import com.sme.meetingassistant.api.intelligence.entity.MeetingDecisionStatusHistoryEntity;
import java.time.OffsetDateTime;
import java.util.UUID;

public record MeetingDecisionStatusHistoryResponse(UUID id, String previousStatus, String status, UUID actorId,
		OffsetDateTime createdAt) {

	public static MeetingDecisionStatusHistoryResponse from(MeetingDecisionStatusHistoryEntity entity) {
		return new MeetingDecisionStatusHistoryResponse(entity.getId(), entity.getPreviousStatus().name(),
				entity.getStatus().name(),
				entity.getActorId(), entity.getCreatedAt());
	}

}
