package com.sme.meetingassistant.api.knowledge;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Authenticated, source-scoped inspection of AI-owned vector persistence. */
public interface KnowledgeVectorAudit {
    Map<SourceKey, Long> countPoints(String generationId, List<SourceKey> sources);

    /** Bounded identity-only inventory of Qdrant points (not an authorization source). */
    InventoryPage inventoryPage(String generationId, String cursor, int limit);

    record SourceKey(String sourceType, UUID sourceId, UUID meetingId, long sourceRevision) { }
    record InventoryPage(List<SourceKey> sources, String nextCursor) { }
}
