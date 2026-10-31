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
    UUID rejectedByUserId,
    String aiUncertainty,
    List<String> aiWarnings,
    AiProducerView aiProducer
) {
    public DecisionView {
        evidenceSegmentIds = evidenceSegmentIds == null ? List.of() : List.copyOf(evidenceSegmentIds);
        aiWarnings=aiWarnings==null ? List.of() : List.copyOf(aiWarnings);
    }

    /** Compatibility constructor for existing human Decision projections/tests. */
    public DecisionView(UUID id, UUID meetingId, String content, String status,
            String sourceType, List<UUID> evidenceSegmentIds, UUID transcriptId,
            Long contentRevision, boolean isStale, long version,
            OffsetDateTime createdAt, UUID createdByUserId,
            OffsetDateTime confirmedAt, UUID confirmedByUserId,
            OffsetDateTime rejectedAt, UUID rejectedByUserId) {
        this(id,meetingId,content,status,sourceType,evidenceSegmentIds,
            transcriptId,contentRevision,isStale,version,createdAt,createdByUserId,
            confirmedAt,confirmedByUserId,rejectedAt,rejectedByUserId,
            null,List.of(),null);
    }
}
