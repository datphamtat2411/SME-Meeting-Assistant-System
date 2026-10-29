package com.sme.meetingassistant.api.meeting.dto;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/** Non-mutating preview; meetingId is used only for organizer-authorized self-exclusion. */
public record MeetingScheduleCheckRequest(
    UUID meetingId, UUID roomId, OffsetDateTime start, OffsetDateTime end,
    List<UUID> participantUserIds
) { }
