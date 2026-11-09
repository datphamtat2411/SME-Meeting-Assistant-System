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
        String tokenizerId) {

    public KnowledgeIndexingEvent {
        if (eventId == null || occurredAt == null || meetingId == null || sourceId == null
                || snapshotId == null || requestId == null || !requestId.matches(
                    "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
                || sourceType == null || !Set.of("TRANSCRIPT", "SUMMARY", "DECISION", "ACTION_ITEM")
                    .contains(sourceType)
                || sourceRevision < 0 || snapshotSizeBytes < 1 || snapshotSizeBytes > 8 * 1024 * 1024
                || snapshotSha256 == null || !snapshotSha256.matches("[a-f0-9]{64}")
                || indexGenerationId == null || indexGenerationId.isBlank()
                || configurationVersion == null || configurationVersion.isBlank()
                || configurationSha256 == null || !configurationSha256.matches("[a-f0-9]{64}")
                || tokenizerId == null || tokenizerId.isBlank()) {
            throw new IllegalArgumentException("Invalid knowledge indexing event");
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

        Map<String, Object> snapshot = new LinkedHashMap<>();
        snapshot.put("snapshotId", snapshotId.toString());
        snapshot.put("sha256", snapshotSha256);
        snapshot.put("sizeBytes", snapshotSizeBytes);

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
        result.put("operation", "UPSERT");
        result.put("snapshot", snapshot);
        result.put("indexGeneration", generation);
        result.put("reason", "NEW_REVISION");
        return result;
    }
}
