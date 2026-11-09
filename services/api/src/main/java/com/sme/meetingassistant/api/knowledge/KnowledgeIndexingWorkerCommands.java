package com.sme.meetingassistant.api.knowledge;

import com.sme.meetingassistant.api.media.worker.WorkerException;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.UUID;
import tools.jackson.databind.JsonNode;

/** Strict bounded command decoder for the authenticated T05-A worker boundary. */
public final class KnowledgeIndexingWorkerCommands {
    private KnowledgeIndexingWorkerCommands() { }

    public record Claim(String contractVersion, int eventSchemaVersion, UUID eventId, String eventType,
            UUID meetingId, String sourceType, UUID sourceId, long sourceRevision, UUID snapshotId,
            String snapshotSha256, long snapshotSizeBytes, String indexGenerationId,
            String configurationVersion, String configurationSha256, String tokenizerId,
            UUID claimRequestId) { }
    public record Owner(String contractVersion, UUID eventId, UUID claimToken) { }
    public record Result(String contractVersion, UUID eventId, UUID claimToken, UUID resultId,
            String state, String indexGenerationId, int chunkCount, String receiptSha256,
            String errorCode) { }

    public static Claim claim(JsonNode input) {
        WorkerJson.fields(input, "contractVersion", "eventId", "eventType", "eventSchemaVersion",
            "meetingId", "sourceIdentity", "sourceRevision", "operation", "snapshot",
            "indexGeneration", "claimRequestId");
        WorkerJson.require("1.0".equals(WorkerJson.string(input, "contractVersion", 8)));
        int schema = (int) WorkerJson.number(input, "eventSchemaVersion", 1, 1);
        UUID eventId = WorkerJson.uuid(input, "eventId");
        WorkerJson.require(KnowledgeIndexingProducer.EVENT_TYPE.equals(
            WorkerJson.string(input, "eventType", 64)));
        WorkerJson.require("UPSERT".equals(WorkerJson.string(input, "operation", 16)));
        UUID meetingId = WorkerJson.uuid(input, "meetingId");

        JsonNode identity = input.get("sourceIdentity");
        WorkerJson.fields(identity, "sourceType", "sourceId", "meetingId");
        String sourceType = WorkerJson.choice(identity, "sourceType", "TRANSCRIPT", "SUMMARY",
            "DECISION", "ACTION_ITEM");
        UUID sourceId = WorkerJson.uuid(identity, "sourceId");
        WorkerJson.require(meetingId.equals(WorkerJson.uuid(identity, "meetingId")));

        JsonNode revision = input.get("sourceRevision");
        WorkerJson.fields(revision, "number");
        long sourceRevision = WorkerJson.number(revision, "number", 0, Long.MAX_VALUE);

        JsonNode snapshot = input.get("snapshot");
        WorkerJson.fields(snapshot, "snapshotId", "sha256", "sizeBytes");
        UUID snapshotId = WorkerJson.uuid(snapshot, "snapshotId");
        String snapshotSha = WorkerJson.digest(snapshot, "sha256");
        long snapshotSize = WorkerJson.number(snapshot, "sizeBytes", 1, 8 * 1024 * 1024);

        JsonNode generation = input.get("indexGeneration");
        WorkerJson.fields(generation, "generationId", "configurationVersion",
            "configurationSha256", "tokenizerId");
        String generationId = WorkerJson.token(generation, "generationId", 128);
        String configurationVersion = WorkerJson.token(generation, "configurationVersion", 128);
        String configurationSha = WorkerJson.digest(generation, "configurationSha256");
        String tokenizerId = WorkerJson.token(generation, "tokenizerId", 128);
        UUID requestId = WorkerJson.uuid(input, "claimRequestId");
        return new Claim("1.0", schema, eventId, KnowledgeIndexingProducer.EVENT_TYPE, meetingId,
            sourceType, sourceId, sourceRevision, snapshotId, snapshotSha, snapshotSize,
            generationId, configurationVersion, configurationSha, tokenizerId, requestId);
    }

    public static Owner owner(JsonNode input) {
        WorkerJson.fields(input, "contractVersion", "eventId", "claimToken");
        WorkerJson.require("1.0".equals(WorkerJson.string(input, "contractVersion", 8)));
        return new Owner("1.0", WorkerJson.uuid(input, "eventId"), WorkerJson.uuid(input, "claimToken"));
    }

    public static Result result(JsonNode input) {
        WorkerJson.fields(input, "contractVersion", "eventId", "claimToken", "resultId",
            "state", "indexGenerationId", "chunkCount", "receiptSha256", "errorCode");
        WorkerJson.require("1.0".equals(WorkerJson.string(input, "contractVersion", 8)));
        String state = WorkerJson.choice(input, "state", "INDEXED", "NO_ELIGIBLE_CONTENT",
            "RETRYABLE_FAILURE", "TERMINAL_FAILURE");
        String error = WorkerJson.string(input, "errorCode", 80);
        WorkerJson.require("NONE".equals(error) || error.matches("[A-Z][A-Z0-9_]{0,79}"));
        WorkerJson.require(("INDEXED".equals(state) || "NO_ELIGIBLE_CONTENT".equals(state))
            ? "NONE".equals(error) : !"NONE".equals(error));
        int chunks = (int) WorkerJson.number(input, "chunkCount", 0, 100_000);
        WorkerJson.require("INDEXED".equals(state) ? chunks > 0 : chunks == 0);
        return new Result("1.0", WorkerJson.uuid(input, "eventId"),
            WorkerJson.uuid(input, "claimToken"), WorkerJson.uuid(input, "resultId"), state,
            WorkerJson.token(input, "indexGenerationId", 128), chunks,
            WorkerJson.digest(input, "receiptSha256"), error);
    }

    public static String fingerprint(Object command) {
        String value = command.toString();
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    public static String tokenHash(UUID token) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(token.toString().getBytes(StandardCharsets.US_ASCII)));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    public static void requireEvent(UUID pathEvent, UUID bodyEvent) {
        if (pathEvent == null || !pathEvent.equals(bodyEvent)) {
            throw WorkerException.conflict("WORKER_IDENTITY_CONFLICT");
        }
    }
}
