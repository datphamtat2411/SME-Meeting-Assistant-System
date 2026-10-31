package com.sme.meetingassistant.api.meetingintelligence.dto;

import java.util.UUID;

/** Source metadata is durable; poll the standard processing-job URL for progress. */
public record RegenerateSummaryResponse(UUID processingJobId, UUID meetingId,
        String status, UUID transcriptId, long contentRevision) {}
