package com.sme.meetingassistant.api.meeting.dto;

import com.sme.meetingassistant.api.meeting.entity.ParticipantRole;
import jakarta.validation.constraints.NotNull;
import java.util.UUID;

public record AddParticipantRequest(@NotNull UUID userId, ParticipantRole role) {
}
