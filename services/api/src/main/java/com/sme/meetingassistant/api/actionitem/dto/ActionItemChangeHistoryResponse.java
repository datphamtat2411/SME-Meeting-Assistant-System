package com.sme.meetingassistant.api.actionitem.dto;

import com.sme.meetingassistant.api.actionitem.entity.ActionItemChangeHistoryEntity;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.UUID;

public record ActionItemChangeHistoryResponse(UUID id, ActionItemStatus previousStatus, ActionItemStatus status,
		UUID previousAssigneeId, UUID assigneeId, LocalDate previousDueDate, LocalDate dueDate, UUID actorId,
		OffsetDateTime createdAt) {

	public static ActionItemChangeHistoryResponse from(ActionItemChangeHistoryEntity entity) {
		return new ActionItemChangeHistoryResponse(entity.getId(), entity.getPreviousStatus(), entity.getStatus(),
				entity.getPreviousAssigneeId(), entity.getAssigneeId(), entity.getPreviousDueDate(), entity.getDueDate(),
				entity.getActorId(), entity.getCreatedAt());
	}

}
