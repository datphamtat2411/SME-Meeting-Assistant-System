package com.sme.meetingassistant.api.transcript.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record CorrectTranscriptSegmentRequest(
    @NotBlank @Size(max = 20_000) String text,
    @Size(max = 1_000) String reason) {}
