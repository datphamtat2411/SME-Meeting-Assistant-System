package com.sme.meetingassistant.api.transcript.dto;

import com.sme.meetingassistant.api.transcript.entity.TranscriptSegmentEntity;
import java.math.BigDecimal;
import java.util.UUID;

public record TranscriptSegmentUpdateResponse(UUID id, int sequenceNumber, long startMs, long endMs, String text,
		String speakerLabel, BigDecimal confidence, long transcriptVersion) {

	public static TranscriptSegmentUpdateResponse from(TranscriptSegmentEntity segment, long transcriptVersion) {
		return new TranscriptSegmentUpdateResponse(segment.getId(), segment.getSequenceNumber(), segment.getStartMs(),
				segment.getEndMs(), segment.getText(), segment.getSpeakerLabel(), segment.getConfidence(), transcriptVersion);
	}

}
