package com.sme.meetingassistant.api.meetingintelligence.dto;

import java.time.OffsetDateTime;
import com.fasterxml.jackson.annotation.JsonIgnore;
import java.util.UUID;
import java.util.List;

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
    UUID createdByUserId,
    @JsonIgnore long selectionEpoch,
    List<String> aiWarnings,
    AiProducerView aiProducer
) {
    public SummaryView {
        aiWarnings=aiWarnings==null ? List.of() : List.copyOf(aiWarnings);
    }

    public SummaryView(UUID id, UUID meetingId, int versionNumber, String content,
            String sourceType, String qualityStatus, UUID processingJobId,
            UUID transcriptId, Long contentRevision, boolean isStale,
            OffsetDateTime createdAt, UUID createdByUserId, long selectionEpoch) {
        this(id,meetingId,versionNumber,content,sourceType,qualityStatus,
            processingJobId,transcriptId,contentRevision,isStale,
            createdAt,createdByUserId,selectionEpoch,List.of(),null);
    }

    public SummaryView(UUID id, UUID meetingId, int versionNumber, String content,
            String sourceType, String qualityStatus, UUID processingJobId,
            UUID transcriptId, Long contentRevision, boolean isStale,
            OffsetDateTime createdAt, UUID createdByUserId) {
        this(id,meetingId,versionNumber,content,sourceType,qualityStatus,
            processingJobId,transcriptId,contentRevision,isStale,
            createdAt,createdByUserId,0L);
    }
}
