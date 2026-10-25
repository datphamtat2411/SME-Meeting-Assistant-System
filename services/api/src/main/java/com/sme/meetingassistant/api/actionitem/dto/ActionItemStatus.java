package com.sme.meetingassistant.api.actionitem.dto;

public enum ActionItemStatus {

	PROPOSED,
	CONFIRMED,
	IN_PROGRESS,
	COMPLETED,
	CANCELLED;

	public boolean isTerminal() {
		return this == COMPLETED || this == CANCELLED;
	}

}
