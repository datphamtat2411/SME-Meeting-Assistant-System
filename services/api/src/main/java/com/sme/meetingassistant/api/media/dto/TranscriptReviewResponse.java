package com.sme.meetingassistant.api.media.dto;

import java.time.OffsetDateTime;
import java.util.UUID;

public record TranscriptReviewResponse(
        UUID reviewId,
        UUID processingJobId,
        UUID meetingId,
        UUID transcriptId,
        long contentRevision,
        String correctionDigest,
        String transcriptStatus,
        UUID acknowledgedByUserId,
        OffsetDateTime acknowledgedAt,
        UUID admittedByUserId,
        OffsetDateTime admittedAt) { }
