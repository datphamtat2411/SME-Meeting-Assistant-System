package com.sme.meetingassistant.api.meeting.dto;

import com.sme.meetingassistant.api.meeting.entity.MeetingEntity;
import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import java.time.OffsetDateTime;
import java.util.UUID;

public record MeetingView(
    UUID id, String title, String description, UUID organizerUserId, UUID roomId,
    OffsetDateTime scheduledStartAt, OffsetDateTime scheduledEndAt, MeetingStatus status,
    OffsetDateTime startedAt, OffsetDateTime endedAt, OffsetDateTime cancelledAt,
    String cancellationReason, UUID createdByUserId, OffsetDateTime createdAt, OffsetDateTime updatedAt
) {
    public static MeetingView from(MeetingEntity m) {
        return new MeetingView(m.getId(),m.getTitle(),m.getDescription(),m.getOrganizerUserId(),m.getRoomId(),
            m.getScheduledStartAt(),m.getScheduledEndAt(),m.getStatus(),m.getStartedAt(),m.getEndedAt(),
            m.getCancelledAt(),m.getCancellationReason(),m.getCreatedByUserId(),m.getCreatedAt(),m.getUpdatedAt());
    }
}
