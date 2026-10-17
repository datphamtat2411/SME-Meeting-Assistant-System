package com.sme.meetingassistant.api.meeting.dto;

import jakarta.validation.constraints.NotNull;
import java.time.OffsetDateTime;

public record ScheduleMeetingRequest(@NotNull OffsetDateTime startTime, @NotNull OffsetDateTime endTime) {
}
