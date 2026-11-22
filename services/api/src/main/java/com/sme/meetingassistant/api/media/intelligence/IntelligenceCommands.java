package com.sme.meetingassistant.api.media.intelligence;

import static com.sme.meetingassistant.api.media.worker.WorkerJson.*;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import java.math.BigDecimal;
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
    public record AttemptReserve(UUID eventId,UUID executionStageRunId,UUID claimToken,UUID attemptId,
            String executionStageCode,long estimatedInputTokens,long outputTokenCeiling,long reservedTokens,
            BigDecimal estimatedCostUsd) {
        public Owner owner() {return new Owner(eventId,executionStageRunId,claimToken);}
    }
    public record AttemptReport(UUID eventId,UUID executionStageRunId,UUID claimToken,UUID attemptId,
            String executionStageCode,String outcome,Long inputTokens,Long outputTokens,Long totalTokens,
            Long reasoningTokens,BigDecimal reportedCostUsd,String failureCategory) {
        public Owner owner() {return new Owner(eventId,executionStageRunId,claimToken);}
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
    public static AttemptReserve attemptReserve(JsonNode n) {
        fields(n,"contractVersion","eventId","executionStageRunId","claimToken","attemptId",
            "executionStageCode","estimatedInputTokens","outputTokenCeiling","reservedTokens","estimatedCostUsd");
        version(n);
        return new AttemptReserve(uuid(n,"eventId"),uuid(n,"executionStageRunId"),uuid(n,"claimToken"),
            uuid(n,"attemptId"),choice(n,"executionStageCode","GENERATING_SUMMARY","EXTRACTING_DECISIONS","EXTRACTING_ACTION_ITEMS"),
            number(n,"estimatedInputTokens",1,272000),number(n,"outputTokenCeiling",1,128000),
            number(n,"reservedTokens",1,400000),decimal(n,"estimatedCostUsd"));
    }
    public static AttemptReport attemptReport(JsonNode n) {
        fields(n,"contractVersion","eventId","executionStageRunId","claimToken","attemptId",
            "executionStageCode","outcome","inputTokens","outputTokens","totalTokens","reasoningTokens",
            "reportedCostUsd","failureCategory");
        version(n);
        var failure=n.get("failureCategory");
        var outcome=choice(n,"outcome","SUCCEEDED","FAILED");
        var failureCategory=failure==null || failure.isNull()?null:choice(n,"failureCategory","VALIDATION","RESOURCE","TIMEOUT",
            "PROVIDER","TRANSPORT","RATE_LIMIT","AUTHENTICATION","CONFIGURATION","MALFORMED_OUTPUT",
            "INTEGRITY","NOT_FOUND","EMPTY_OUTPUT","CANCELLED");
        var inputTokens=nullableNumber(n,"inputTokens",0,Long.MAX_VALUE);
        var outputTokens=nullableNumber(n,"outputTokens",0,Long.MAX_VALUE);
        var totalTokens=nullableNumber(n,"totalTokens",0,Long.MAX_VALUE);
        var reasoningTokens=nullableNumber(n,"reasoningTokens",0,Long.MAX_VALUE);
        var reportedCost=nullableDecimal(n,"reportedCostUsd");
        validateReport(outcome,inputTokens,outputTokens,totalTokens,reasoningTokens,
            reportedCost,failureCategory);
        return new AttemptReport(uuid(n,"eventId"),uuid(n,"executionStageRunId"),uuid(n,"claimToken"),
            uuid(n,"attemptId"),choice(n,"executionStageCode","GENERATING_SUMMARY","EXTRACTING_DECISIONS","EXTRACTING_ACTION_ITEMS"),
            outcome,
            inputTokens,outputTokens,totalTokens,reasoningTokens,reportedCost,
            failureCategory);
    }
    private static void validateReport(String outcome,Long input,Long output,Long total,Long reasoning,
            BigDecimal cost,String failure) {
        boolean complete=input!=null && output!=null && total!=null;
        boolean any=input!=null || output!=null || total!=null || reasoning!=null;
        if (!Set.of("SUCCEEDED","FAILED").contains(outcome)
            || ("SUCCEEDED".equals(outcome) && (failure!=null || !complete || cost==null))
            || ("FAILED".equals(outcome) && failure==null)
            || any && !complete
            || reasoning!=null && output==null
            || cost!=null && cost.signum()<0) throw new WorkerException(422,"VALIDATION_ERROR");
        if (complete) try {
            if (Math.addExact(input,output)!=total || reasoning!=null && reasoning>output)
                throw new WorkerException(422,"VALIDATION_ERROR");
        } catch (ArithmeticException invalid) {
            throw new WorkerException(422,"VALIDATION_ERROR");
        }
    }
    public static Fail fail(JsonNode n) {
        fields(n,"contractVersion","commandId","eventId","executionStageRunId","claimToken","phase","category");
        return new Fail(uuid(n,"commandId"),identity(n),
            choice(n,"phase","SOURCE_DOWNLOAD","INFERENCE","RESULT_VALIDATION","RESULT_STORAGE","PUBLICATION","INTERRUPTED"),
            choice(n,"category","VALIDATION","RESOURCE","TIMEOUT","PROVIDER","TRANSPORT","RATE_LIMIT","AUTHENTICATION","CONFIGURATION","MALFORMED_OUTPUT","INTEGRITY","NOT_FOUND","EMPTY_OUTPUT","CANCELLED"));
    }
    public static String fingerprint(Object command) {return sha256(MAPPER.writeValueAsBytes(command));}
}
