package com.sme.meetingassistant.api.knowledge;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Exact bounded notification shared with the Python knowledge-indexing decoder. */
public record KnowledgeIndexingEvent(
        UUID eventId,
        OffsetDateTime occurredAt,
        String requestId,
        UUID meetingId,
        String sourceType,
        UUID sourceId,
        long sourceRevision,
        UUID snapshotId,
        String snapshotSha256,
        long snapshotSizeBytes,
        String indexGenerationId,
        String configurationVersion,
        String configurationSha256,
        String tokenizerId,
        String operation,
        String reason) {

    /** T05 source-compatible constructor for the original UPSERT contract. */
    public KnowledgeIndexingEvent(UUID eventId, OffsetDateTime occurredAt, String requestId,
            UUID meetingId, String sourceType, UUID sourceId, long sourceRevision,
            UUID snapshotId, String snapshotSha256, long snapshotSizeBytes,
            String indexGenerationId, String configurationVersion, String configurationSha256,
            String tokenizerId) {
        this(eventId, occurredAt, requestId, meetingId, sourceType, sourceId, sourceRevision,
            snapshotId, snapshotSha256, snapshotSizeBytes, indexGenerationId, configurationVersion,
            configurationSha256, tokenizerId, "UPSERT", "NEW_REVISION");
    }

    public KnowledgeIndexingEvent {
        if (eventId == null || occurredAt == null || meetingId == null || sourceId == null
                || requestId == null || !requestId.matches(
                    "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
                 || sourceType == null || !Set.of("TRANSCRIPT", "SUMMARY", "DECISION", "ACTION_ITEM")
                     .contains(sourceType) || sourceRevision < 0
                 || indexGenerationId == null || indexGenerationId.isBlank()
                 || configurationVersion == null || configurationVersion.isBlank()
                 || configurationSha256 == null || !configurationSha256.matches("[a-f0-9]{64}")
                 || tokenizerId == null || tokenizerId.isBlank()
                 || operation == null || reason == null
                 || !Set.of("UPSERT", "INVALIDATE", "DELETE").contains(operation)
                 || !Set.of("NEW_REVISION", "ELIGIBILITY_CHANGED", "SOURCE_SUPERSEDED",
                     "SOURCE_DELETED", "REINDEX_REQUESTED", "RECONCILIATION_REQUESTED").contains(reason)) {
            throw new IllegalArgumentException("Invalid knowledge indexing event");
        }
        if ("UPSERT".equals(operation)
                && (snapshotId == null || snapshotSizeBytes < 1 || snapshotSizeBytes > 8 * 1024 * 1024
                    || snapshotSha256 == null || !snapshotSha256.matches("[a-f0-9]{64}")
                    || !Set.of("NEW_REVISION", "REINDEX_REQUESTED", "RECONCILIATION_REQUESTED").contains(reason))) {
            throw new IllegalArgumentException("Invalid knowledge upsert event");
        }
        if (!"UPSERT".equals(operation)
                && (snapshotId != null || snapshotSha256 != null || snapshotSizeBytes != 0
                    || "NEW_REVISION".equals(reason) || "REINDEX_REQUESTED".equals(reason))) {
            throw new IllegalArgumentException("Lifecycle event must not carry a snapshot");
        }
        if ("INVALIDATE".equals(operation) && !Set.of("ELIGIBILITY_CHANGED", "SOURCE_SUPERSEDED",
                "SOURCE_DELETED", "RECONCILIATION_REQUESTED").contains(reason)) {
            throw new IllegalArgumentException("Invalid invalidation reason");
        }
        if ("DELETE".equals(operation) && !"SOURCE_DELETED".equals(reason)) {
            throw new IllegalArgumentException("Delete requires source deletion reason");
        }
        occurredAt = occurredAt.withOffsetSameInstant(ZoneOffset.UTC);
    }

    public Map<String, Object> payload() {
        Map<String, Object> sourceIdentity = new LinkedHashMap<>();
        sourceIdentity.put("sourceType", sourceType);
        sourceIdentity.put("sourceId", sourceId.toString());
        sourceIdentity.put("meetingId", meetingId.toString());

        Map<String, Object> sourceRevisionValue = new LinkedHashMap<>();
        sourceRevisionValue.put("number", sourceRevision);

        Map<String, Object> generation = new LinkedHashMap<>();
        generation.put("generationId", indexGenerationId);
        generation.put("configurationVersion", configurationVersion);
        generation.put("configurationSha256", configurationSha256);
        generation.put("tokenizerId", tokenizerId);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("contractVersion", "1.0");
        result.put("schemaVersion", 1);
        result.put("eventId", eventId.toString());
        result.put("occurredAt", occurredAt.toString());
        result.put("requestId", requestId);
        result.put("meetingId", meetingId.toString());
        result.put("sourceIdentity", sourceIdentity);
        result.put("sourceRevision", sourceRevisionValue);
        result.put("operation", operation);
        if ("UPSERT".equals(operation)) {
            Map<String, Object> snapshot = new LinkedHashMap<>();
            snapshot.put("snapshotId", snapshotId.toString());
            snapshot.put("sha256", snapshotSha256);
            snapshot.put("sizeBytes", snapshotSizeBytes);
            result.put("snapshot", snapshot);
        }
        result.put("indexGeneration", generation);
        result.put("reason", reason);
        return result;
    }
}
