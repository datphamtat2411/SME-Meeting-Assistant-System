package com.sme.meetingassistant.api.meetingintelligence.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.UUID;

/** Manual creation only; official status, actor and timestamps are server-assigned. */
public record CreateDecisionRequest(
    @NotBlank @Size(max = 5_000) String content,
    @Size(max = 50) List<@NotNull UUID> evidenceSegmentIds
) { }
