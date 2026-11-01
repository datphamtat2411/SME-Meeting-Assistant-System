package com.sme.meetingassistant.api.meetingintelligence.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** Status transitions use explicit confirm/reject commands, not PATCH. */
public record EditDecisionRequest(@NotBlank @Size(max = 5_000) String content) { }
