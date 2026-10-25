package com.sme.meetingassistant.api.actionitem.dto;

import com.sme.meetingassistant.api.actionitem.entity.ActionItemEntity;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

public record ActionItemResponse(UUID id, UUID meetingId, UUID sourceTranscriptId, String title, UUID assigneeId,
		LocalDate dueDate, ActionItemStatus status, List<UUID> evidenceSegmentIds, boolean overdue,
		long concurrencyVersion, OffsetDateTime createdAt, OffsetDateTime updatedAt) {

	public ActionItemResponse {
		evidenceSegmentIds = List.copyOf(evidenceSegmentIds);
	}

	public static ActionItemResponse from(ActionItemEntity entity, List<UUID> evidenceSegmentIds, LocalDate today) {
		boolean overdue = entity.getDueDate() != null && entity.getDueDate().isBefore(today)
				&& !entity.getStatus().isTerminal();
		return new ActionItemResponse(entity.getId(), entity.getMeetingId(), entity.getSourceTranscriptId(),
				entity.getTitle(), entity.getAssigneeId(), entity.getDueDate(), entity.getStatus(), evidenceSegmentIds,
				overdue, entity.getConcurrencyVersion(), entity.getCreatedAt(), entity.getUpdatedAt());
	}

}
