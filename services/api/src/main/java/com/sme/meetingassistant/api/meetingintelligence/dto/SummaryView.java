package com.sme.meetingassistant.api.meetingintelligence.dto;

import java.time.OffsetDateTime;
import java.util.UUID;

/** Current Summary read model, never a JPA entity or an input to a mutation. */
public record SummaryView(
    UUID id,
    UUID meetingId,
    int versionNumber,
    String content,
    String sourceType,
    String qualityStatus,
    UUID processingJobId,
    UUID transcriptId,
    Long contentRevision,
    boolean isStale,
    OffsetDateTime createdAt,
    UUID createdByUserId
) { }
