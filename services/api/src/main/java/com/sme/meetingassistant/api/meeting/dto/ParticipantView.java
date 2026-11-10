package com.sme.meetingassistant.api.meeting.dto;

import com.sme.meetingassistant.api.meeting.entity.MeetingParticipantEntity;
import java.time.OffsetDateTime;
import java.util.UUID;

public record ParticipantView(UUID id, UUID meetingId, UUID userId, UUID addedByUserId,
    OffsetDateTime addedAt, OffsetDateTime removedAt, UUID removedByUserId, String displayName) {
    public static ParticipantView from(MeetingParticipantEntity p, String displayName) {
        return new ParticipantView(p.getId(),p.getMeetingId(),p.getUserId(),p.getAddedByUserId(),
            p.getAddedAt(),p.getRemovedAt(),p.getRemovedByUserId(),displayName);
    }
}
