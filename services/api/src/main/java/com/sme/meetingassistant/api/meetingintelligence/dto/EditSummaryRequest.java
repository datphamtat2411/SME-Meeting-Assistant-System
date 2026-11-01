package com.sme.meetingassistant.api.meetingintelligence.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** Only user-editable content; source, actor and version are server-owned. */
public record EditSummaryRequest(@NotBlank @Size(max = 20_000) String content) { }
