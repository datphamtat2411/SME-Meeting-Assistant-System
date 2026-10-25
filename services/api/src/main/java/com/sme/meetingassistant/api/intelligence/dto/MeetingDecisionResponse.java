package com.sme.meetingassistant.api.intelligence.dto;

import com.sme.meetingassistant.api.intelligence.entity.MeetingDecisionEntity;
import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

public record MeetingDecisionResponse(UUID id, UUID meetingId, UUID summaryId, String statement,
		MeetingDecisionStatus status, BigDecimal confidence, List<UUID> evidenceSegmentIds, long concurrencyVersion,
		OffsetDateTime createdAt, OffsetDateTime updatedAt) {

	public MeetingDecisionResponse {
		evidenceSegmentIds = List.copyOf(evidenceSegmentIds);
	}

	public static MeetingDecisionResponse from(MeetingDecisionEntity entity, List<UUID> evidenceSegmentIds) {
		return new MeetingDecisionResponse(entity.getId(), entity.getMeetingId(), entity.getSummaryId(),
				entity.getStatement(), entity.getStatus(), entity.getConfidence(), evidenceSegmentIds,
				entity.getConcurrencyVersion(), entity.getCreatedAt(), entity.getUpdatedAt());
	}

}
