package com.sme.meetingassistant.api.knowledge;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class KnowledgeIndexingEventContractTests {
    @Test
    void eventUsesTheBoundedPythonNotificationContract() {
        UUID eventId = UUID.randomUUID();
        UUID meetingId = UUID.randomUUID();
        UUID sourceId = UUID.randomUUID();
        UUID snapshotId = UUID.randomUUID();
        var event = new KnowledgeIndexingEvent(eventId,
            OffsetDateTime.of(2026, 11, 10, 12, 0, 0, 0, ZoneOffset.UTC),
            "trace-1", meetingId, "TRANSCRIPT", sourceId, 4, snapshotId,
            "a".repeat(64), 512, "rag-t01-v1", "chunking-v1", "b".repeat(64),
            "bge-m3");

        assertThat(event.payload()).containsEntry("contractVersion", "1.0")
            .containsEntry("schemaVersion", 1)
            .containsEntry("eventId", eventId.toString())
            .containsEntry("operation", "UPSERT")
            .containsEntry("requestId", "trace-1")
            .containsEntry("meetingId", meetingId.toString());
        assertThat(event.payload()).doesNotContainKey("content");
        assertThat(event.payload().get("sourceIdentity")).isEqualTo(
            java.util.Map.of("sourceType", "TRANSCRIPT", "sourceId", sourceId.toString(),
                "meetingId", meetingId.toString()));
        assertThat(event.payload().get("snapshot")).isEqualTo(
            java.util.Map.of("snapshotId", snapshotId.toString(), "sha256", "a".repeat(64),
                "sizeBytes", 512L));
    }

    @Test
    void lifecycleEventCarriesIdentityAndGenerationButNoSnapshot() {
        UUID meetingId = UUID.randomUUID();
        var event = new KnowledgeIndexingEvent(UUID.randomUUID(),
            OffsetDateTime.of(2026, 11, 10, 12, 0, 0, 0, ZoneOffset.UTC),
            "trace-2", meetingId, "SUMMARY", UUID.randomUUID(), 7, null,
            null, 0, "rag-t01-v1", "chunking-v1", "b".repeat(64),
            "bge-m3", "INVALIDATE", "ELIGIBILITY_CHANGED");

        assertThat(event.payload()).doesNotContainKey("snapshot")
            .containsEntry("operation", "INVALIDATE")
            .containsEntry("reason", "ELIGIBILITY_CHANGED");
    }
}
