package com.sme.meetingassistant.api.intelligence.service;

import com.sme.meetingassistant.api.intelligence.dto.IngestMeetingIntelligenceRequest;
import com.sme.meetingassistant.api.intelligence.dto.MeetingSummaryResponse;

/** Application boundary for derived meeting intelligence supplied by an AI adapter. */
public interface MeetingIntelligenceIngestion {

	MeetingSummaryResponse ingest(IngestMeetingIntelligenceRequest request);

}
