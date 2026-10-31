package com.sme.meetingassistant.api.meetingintelligence.dto;

import com.fasterxml.jackson.annotation.JsonIgnore;
import java.time.OffsetDateTime;
import java.util.UUID;
import java.util.List;

/** Authorization-scoped immutable version and its derived selection/freshness state. */
public record SummaryVersionView(
    UUID id, UUID meetingId, int versionNumber, String content,
    String sourceType, String qualityStatus, UUID processingJobId,
    UUID transcriptId, Long contentRevision, boolean isStale,
    OffsetDateTime createdAt, UUID createdByUserId,
    boolean isCurrent, @JsonIgnore long selectionEpoch,
    List<String> aiWarnings, AiProducerView aiProducer
) {
    public SummaryVersionView {
        aiWarnings=aiWarnings==null ? List.of() : List.copyOf(aiWarnings);
    }

    public SummaryView summary() {
        return new SummaryView(id,meetingId,versionNumber,content,sourceType,
            qualityStatus,processingJobId,transcriptId,contentRevision,isStale,
            createdAt,createdByUserId,selectionEpoch,aiWarnings,aiProducer);
    }
}
