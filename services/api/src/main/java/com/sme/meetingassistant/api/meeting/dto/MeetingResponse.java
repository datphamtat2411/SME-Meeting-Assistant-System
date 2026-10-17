package com.sme.meetingassistant.api.meeting.dto;

import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import java.time.OffsetDateTime;
import java.util.UUID;

public record MeetingResponse(
		UUID id,
		String title,
		MeetingStatus status,
		OffsetDateTime startTime,
		OffsetDateTime endTime,
		long version) {
}
