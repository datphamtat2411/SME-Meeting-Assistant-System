package com.sme.meetingassistant.api.meeting.dto;

import jakarta.validation.constraints.NotNull;
import java.util.UUID;

public record AddParticipantRequest(@NotNull UUID userId) { }
