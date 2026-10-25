package com.sme.meetingassistant.api.intelligence.dto;

import jakarta.validation.constraints.NotNull;

public record UpdateDecisionStatusRequest(@NotNull MeetingDecisionStatus status) {
}
