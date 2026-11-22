package com.sme.meetingassistant.api.media.dto;

import jakarta.validation.constraints.NotNull;
import java.util.UUID;

/** Binds the explicit MI admission to one already persisted transcript review. */
public record AdmitMeetingIntelligenceRequest(
        @NotNull UUID reviewId,
        @NotNull UUID transcriptId,
        long contentRevision,
        String correctionDigest) { }
