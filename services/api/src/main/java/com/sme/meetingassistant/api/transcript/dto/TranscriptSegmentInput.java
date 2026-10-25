package com.sme.meetingassistant.api.transcript.dto;

import java.math.BigDecimal;

public record TranscriptSegmentInput(int sequenceNumber, long startMs, long endMs, String text, String speakerLabel,
		BigDecimal confidence) {
}
