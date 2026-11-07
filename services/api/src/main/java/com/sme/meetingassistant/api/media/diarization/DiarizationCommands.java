package com.sme.meetingassistant.api.media.diarization;

import static com.sme.meetingassistant.api.media.worker.WorkerJson.*;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import java.util.Set;
import java.util.UUID;
import tools.jackson.databind.JsonNode;

public final class DiarizationCommands {
    private DiarizationCommands() {}
    public record Claim(UUID eventId,String eventType,int eventSchemaVersion,UUID meetingId,
        UUID sourceMediaId,UUID executionStageRunId,UUID claimRequestId) {}
    public record Owner(UUID eventId,UUID executionStageRunId,UUID claimToken) {
        @Override public String toString() { return "DiarizationOwner[redacted]"; }
    }
    public record Complete(UUID commandId,Owner owner,String resultSha256,UUID resultProducerStageRunId) {}
    public record Fail(UUID commandId,Owner owner,String phase,String category) {
        public boolean retryable() { return Set.of("RESOURCE","TIMEOUT","PROVIDER","TRANSPORT","RATE_LIMIT","CANCELLED").contains(category); }
    }
    private static void version(JsonNode n) {
        if(!"1.0".equals(string(n,"contractVersion",16))) throw new WorkerException(422,"WORKER_CONTRACT_UNSUPPORTED");
    }
    public static Claim claim(JsonNode n) {
        fields(n,"contractVersion","eventId","eventType","eventSchemaVersion","meetingId","sourceMediaId","executionStageRunId","claimRequestId");
        version(n);
        return new Claim(uuid(n,"eventId"),choice(n,"eventType","PROCESSING_DIARIZATION_REQUESTED"),
            (int)number(n,"eventSchemaVersion",1,1),uuid(n,"meetingId"),uuid(n,"sourceMediaId"),uuid(n,"executionStageRunId"),uuid(n,"claimRequestId"));
    }
    private static Owner identity(JsonNode n) {
        version(n);return new Owner(uuid(n,"eventId"),uuid(n,"executionStageRunId"),uuid(n,"claimToken"));
    }
    public static Owner owner(JsonNode n) {
        fields(n,"contractVersion","eventId","executionStageRunId","claimToken");return identity(n);
    }
    public static Complete complete(JsonNode n) {
        fields(n,"contractVersion","commandId","eventId","executionStageRunId","claimToken","resultSha256","resultProducerStageRunId");
        return new Complete(uuid(n,"commandId"),identity(n),digest(n,"resultSha256"),uuid(n,"resultProducerStageRunId"));
    }
    public static Fail fail(JsonNode n) {
        fields(n,"contractVersion","commandId","eventId","executionStageRunId","claimToken","phase","category");
        return new Fail(uuid(n,"commandId"),identity(n),
            choice(n,"phase","SOURCE_DOWNLOAD","SNAPSHOT","PREPROCESSING","INFERENCE","ALIGNMENT","RESULT_VALIDATION","RESULT_STORAGE","PUBLICATION","INTERRUPTED"),
            choice(n,"category","VALIDATION","DECODING","RESOURCE","TIMEOUT","PROVIDER","TRANSPORT","RATE_LIMIT","AUTHENTICATION","CONFIGURATION","MALFORMED_OUTPUT","INTEGRITY","NOT_FOUND","EMPTY_OUTPUT","CANCELLED"));
    }
    public static String fingerprint(Object cmd) { return sha256(MAPPER.writeValueAsBytes(cmd)); }
}
