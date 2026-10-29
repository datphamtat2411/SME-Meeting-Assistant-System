package com.sme.meetingassistant.api.meeting.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

public record CreateMeetingRequest(
    @NotBlank @Size(max = 255) String title,
    String description,
    OffsetDateTime scheduledStartAt,
    OffsetDateTime scheduledEndAt,
    UUID roomId,
    List<UUID> participantUserIds
) { }
