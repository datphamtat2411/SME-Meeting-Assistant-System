package com.sme.meetingassistant.api.intelligence.dto;

import java.util.List;
import java.util.UUID;

public record IngestMeetingIntelligenceRequest(UUID meetingId, UUID sourceTranscriptId, String title, String overview,
		List<String> keyPoints, List<DecisionProposalInput> decisions) {
}
