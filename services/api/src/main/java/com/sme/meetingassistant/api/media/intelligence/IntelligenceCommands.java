package com.sme.meetingassistant.api.media.intelligence;

import static com.sme.meetingassistant.api.media.worker.WorkerJson.*;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import java.util.Set;
import java.util.UUID;
import tools.jackson.databind.JsonNode;

public final class IntelligenceCommands {
    private IntelligenceCommands() {}
    public record Claim(UUID eventId,String eventType,int eventSchemaVersion,UUID executionStageRunId,
            String executionStageCode,UUID claimRequestId) {}
    public record Owner(UUID eventId,UUID executionStageRunId,UUID claimToken) {
        @Override public String toString() {return "IntelligenceOwner[redacted]";}
    }
    public record Fail(UUID commandId,Owner owner,String phase,String category) {
        public boolean retryable() {return Set.of("RESOURCE","TIMEOUT","PROVIDER","TRANSPORT","RATE_LIMIT","CANCELLED").contains(category);}
    }
    private static void version(JsonNode n) {if(!"1.0".equals(string(n,"contractVersion",16))) throw new WorkerException(422,"WORKER_CONTRACT_UNSUPPORTED");}
    public static Claim claim(JsonNode n) {
        fields(n,"contractVersion","eventId","eventType","eventSchemaVersion","executionStageRunId","executionStageCode","claimRequestId");version(n);
        return new Claim(uuid(n,"eventId"),choice(n,"eventType","PROCESSING_INTELLIGENCE_STAGE_REQUESTED"),
            (int)number(n,"eventSchemaVersion",1,1),uuid(n,"executionStageRunId"),
            choice(n,"executionStageCode","GENERATING_SUMMARY","EXTRACTING_DECISIONS","EXTRACTING_ACTION_ITEMS"),uuid(n,"claimRequestId"));
    }
    private static Owner identity(JsonNode n) {version(n);return new Owner(uuid(n,"eventId"),uuid(n,"executionStageRunId"),uuid(n,"claimToken"));}
    public static Owner owner(JsonNode n) {fields(n,"contractVersion","eventId","executionStageRunId","claimToken");return identity(n);}
    public static Fail fail(JsonNode n) {
        fields(n,"contractVersion","commandId","eventId","executionStageRunId","claimToken","phase","category");
        return new Fail(uuid(n,"commandId"),identity(n),
            choice(n,"phase","SOURCE_DOWNLOAD","INFERENCE","RESULT_VALIDATION","RESULT_STORAGE","PUBLICATION","INTERRUPTED"),
            choice(n,"category","VALIDATION","RESOURCE","TIMEOUT","PROVIDER","TRANSPORT","RATE_LIMIT","AUTHENTICATION","CONFIGURATION","MALFORMED_OUTPUT","INTEGRITY","NOT_FOUND","EMPTY_OUTPUT","CANCELLED"));
    }
    public static String fingerprint(Object command) {return sha256(MAPPER.writeValueAsBytes(command));}
}
