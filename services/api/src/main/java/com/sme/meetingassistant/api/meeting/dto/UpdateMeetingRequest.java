package com.sme.meetingassistant.api.meeting.dto;

import jakarta.validation.constraints.Size;

public record UpdateMeetingRequest(
		@Size(min = 1, max = 255) String title,
		@Size(max = 10000) String description) {
	public boolean isEmpty() { return this.title == null && this.description == null; }
}
