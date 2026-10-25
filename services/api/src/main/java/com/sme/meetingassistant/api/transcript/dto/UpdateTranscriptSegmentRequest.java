package com.sme.meetingassistant.api.transcript.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record UpdateTranscriptSegmentRequest(@NotBlank String text, @Size(max = 255) String speakerLabel) {
}
