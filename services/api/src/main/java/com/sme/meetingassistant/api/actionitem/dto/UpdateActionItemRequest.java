package com.sme.meetingassistant.api.actionitem.dto;

public record UpdateActionItemRequest(ActionItemStatus status, java.util.UUID assigneeId,
		java.time.LocalDate dueDate) {

	public boolean isEmpty() {
		return this.status == null && this.assigneeId == null && this.dueDate == null;
	}

}
