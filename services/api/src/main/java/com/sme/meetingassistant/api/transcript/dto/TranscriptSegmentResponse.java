package com.sme.meetingassistant.api.transcript.dto;

import com.sme.meetingassistant.api.transcript.entity.TranscriptSegmentEntity;
import java.math.BigDecimal;
import java.util.UUID;

public record TranscriptSegmentResponse(UUID id, int sequenceNumber, long startMs, long endMs, String text,
		String speakerLabel, BigDecimal confidence) {

	public static TranscriptSegmentResponse from(TranscriptSegmentEntity segment) {
		return new TranscriptSegmentResponse(segment.getId(), segment.getSequenceNumber(), segment.getStartMs(),
				segment.getEndMs(), segment.getText(), segment.getSpeakerLabel(), segment.getConfidence());
	}

}
