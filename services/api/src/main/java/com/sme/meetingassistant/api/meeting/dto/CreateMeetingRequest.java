package com.sme.meetingassistant.api.meeting.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record CreateMeetingRequest(
		@NotBlank @Size(max = 255) String title,
		@Size(max = 10000) String description) {
}
