package com.sme.meetingassistant.api.meeting.dto;

import com.sme.meetingassistant.api.meeting.entity.MeetingEntity;
import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/** The list representation adds page-scoped display metadata to the canonical meeting fields. */
public record MeetingListView(
    UUID id, String title, String description, UUID organizerUserId, UUID roomId,
    OffsetDateTime scheduledStartAt, OffsetDateTime scheduledEndAt, MeetingStatus status,
    OffsetDateTime startedAt, OffsetDateTime endedAt, OffsetDateTime cancelledAt,
    String cancellationReason, UUID createdByUserId, OffsetDateTime createdAt, OffsetDateTime updatedAt,
    Display display
) {
    public static MeetingListView from(MeetingEntity meeting, Display display) {
        return new MeetingListView(meeting.getId(), meeting.getTitle(), meeting.getDescription(),
            meeting.getOrganizerUserId(), meeting.getRoomId(), meeting.getScheduledStartAt(),
            meeting.getScheduledEndAt(), meeting.getStatus(), meeting.getStartedAt(),
            meeting.getEndedAt(), meeting.getCancelledAt(), meeting.getCancellationReason(),
            meeting.getCreatedByUserId(), meeting.getCreatedAt(), meeting.getUpdatedAt(), display);
    }

    public record Display(String organizerName, String roomName, String roomLocation,
            int participantCount, List<ParticipantPreview> participantPreview) {
        public Display {
            participantPreview = List.copyOf(participantPreview);
        }
    }

    public record ParticipantPreview(UUID userId, String displayName) { }
}
