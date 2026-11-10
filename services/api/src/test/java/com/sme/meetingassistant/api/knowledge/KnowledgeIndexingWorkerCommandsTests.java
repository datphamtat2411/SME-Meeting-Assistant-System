package com.sme.meetingassistant.api.knowledge;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.media.worker.WorkerException;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class KnowledgeIndexingWorkerCommandsTests {
    @Test
    void claimRequiresTheVersionedUpsertReferenceContract() {
        UUID eventId = UUID.randomUUID();
        UUID meetingId = UUID.randomUUID();
        UUID sourceId = UUID.randomUUID();
        UUID snapshotId = UUID.randomUUID();
        JsonBuilder body = new JsonBuilder(eventId, meetingId, sourceId, snapshotId);

        var command = KnowledgeIndexingWorkerCommands.claim(body.node());

        assertThat(command.eventId()).isEqualTo(eventId);
        assertThat(command.eventSchemaVersion()).isOne();
        assertThat(command.sourceType()).isEqualTo("SUMMARY");
        assertThat(command.sourceRevision()).isEqualTo(7);
    }

    @Test
    void claimRejectsNonUpsertAndUnexpectedFields() {
        UUID eventId = UUID.randomUUID();
        JsonBuilder body = new JsonBuilder(eventId, UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID());
        body.node().put("operation", "DELETE");
        assertThatThrownBy(() -> KnowledgeIndexingWorkerCommands.claim(body.node()))
            .isInstanceOf(WorkerException.class);

        JsonBuilder extra = new JsonBuilder(eventId, UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID());
        extra.node().put("reason", "NEW_REVISION");
        assertThatThrownBy(() -> KnowledgeIndexingWorkerCommands.claim(extra.node()))
            .isInstanceOf(WorkerException.class);
    }

    @Test
    void claimAcceptsLifecycleWithoutSnapshot() {
        JsonBuilder body = new JsonBuilder(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID());
        body.node().remove("snapshot");
        body.node().put("operation", "INVALIDATE");
        body.node().put("reason", "ELIGIBILITY_CHANGED");

        var command = KnowledgeIndexingWorkerCommands.claim(body.node());

        assertThat(command.operation()).isEqualTo("INVALIDATE");
        assertThat(command.reason()).isEqualTo("ELIGIBILITY_CHANGED");
        assertThat(command.snapshotId()).isNull();
        assertThat(command.snapshotSizeBytes()).isZero();
    }

    private static final class JsonBuilder {
        private final tools.jackson.databind.node.ObjectNode node;

        private JsonBuilder(UUID eventId, UUID meetingId, UUID sourceId, UUID snapshotId) {
            node = WorkerJson.MAPPER.createObjectNode()
                .put("contractVersion", "1.0")
                .put("eventId", eventId.toString())
                .put("eventType", KnowledgeIndexingProducer.EVENT_TYPE)
                .put("eventSchemaVersion", 1)
                .put("meetingId", meetingId.toString())
                .put("operation", "UPSERT")
                .put("claimRequestId", UUID.randomUUID().toString());
            node.set("sourceIdentity", WorkerJson.MAPPER.createObjectNode()
                .put("sourceType", "SUMMARY")
                .put("sourceId", sourceId.toString())
                .put("meetingId", meetingId.toString()));
            node.set("sourceRevision", WorkerJson.MAPPER.createObjectNode().put("number", 7));
            node.set("snapshot", WorkerJson.MAPPER.createObjectNode()
                .put("snapshotId", snapshotId.toString())
                .put("sha256", "a".repeat(64))
                .put("sizeBytes", 512));
            node.set("indexGeneration", WorkerJson.MAPPER.createObjectNode()
                .put("generationId", "rag-t01-v1")
                .put("configurationVersion", "chunking-v1")
                .put("configurationSha256", "b".repeat(64))
                .put("tokenizerId", "bge-m3"));
        }

        private tools.jackson.databind.node.ObjectNode node() {
            return node;
        }
    }
}
