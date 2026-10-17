package com.sme.meetingassistant.api.meeting.dto;

import com.sme.meetingassistant.api.meeting.entity.ParticipantRole;
import com.sme.meetingassistant.api.meeting.entity.ParticipantStatus;
import java.time.OffsetDateTime;
import java.util.UUID;

public record ParticipantResponse(
		UUID id,
		UUID userId,
		ParticipantRole role,
		ParticipantStatus status,
		OffsetDateTime createdAt,
		OffsetDateTime removedAt) {
}
