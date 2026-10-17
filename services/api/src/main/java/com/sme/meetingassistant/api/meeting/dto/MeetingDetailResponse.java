package com.sme.meetingassistant.api.meeting.dto;

import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import java.time.OffsetDateTime;
import java.util.UUID;

public record MeetingDetailResponse(
		UUID id,
		String title,
		String description,
		MeetingStatus status,
		UUID organizerId,
		OffsetDateTime startTime,
		OffsetDateTime endTime,
		long version,
		OffsetDateTime createdAt,
		OffsetDateTime updatedAt) {
}
