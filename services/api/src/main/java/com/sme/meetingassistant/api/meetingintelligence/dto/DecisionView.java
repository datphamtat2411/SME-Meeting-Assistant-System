package com.sme.meetingassistant.api.meetingintelligence.dto;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/** Authorized decision projection. Status/attribution are canonical server output. */
public record DecisionView(
    UUID id,
    UUID meetingId,
    String content,
    String status,
    String sourceType,
    List<UUID> evidenceSegmentIds,
    UUID transcriptId,
    Long contentRevision,
    boolean isStale,
    long version,
    OffsetDateTime createdAt,
    UUID createdByUserId,
    OffsetDateTime confirmedAt,
    UUID confirmedByUserId,
    OffsetDateTime rejectedAt,
    UUID rejectedByUserId
) {
    public DecisionView {
        evidenceSegmentIds = evidenceSegmentIds == null ? List.of() : List.copyOf(evidenceSegmentIds);
    }
}
