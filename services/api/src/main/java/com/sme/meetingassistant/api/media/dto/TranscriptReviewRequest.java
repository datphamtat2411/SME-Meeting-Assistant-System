package com.sme.meetingassistant.api.media.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.PositiveOrZero;
import java.util.UUID;

/** Immutable client proof for the exact transcript revision reviewed in Core. */
public record TranscriptReviewRequest(
        @NotNull UUID transcriptId,
        @PositiveOrZero long contentRevision,
        @NotBlank String correctionDigest) { }
