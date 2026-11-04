package com.sme.meetingassistant.api.media.worker;

import static com.sme.meetingassistant.api.media.worker.WorkerJson.*;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import tools.jackson.databind.JsonNode;

public final class WorkerCommands {
    private WorkerCommands() {}
    public record Claim(UUID eventId,String eventType,int eventSchemaVersion,UUID meetingId,
        UUID sourceMediaId,UUID requestedByUserId,int generation,UUID claimRequestId) {}
    public record Owner(UUID eventId,int generation,UUID executionStageRunId,UUID claimToken) {
        @Override public String toString() { return "WorkerOwner[redacted]"; }
    }
    public record Complete(UUID commandId,Owner owner,String resultSha256,UUID resultProducerStageRunId) {}
    public record Fail(UUID commandId,Owner owner,String phase,String category,String completedThrough,Map<String,Long> metrics) {}
    private static void version(JsonNode n) {
        if (!"1.0".equals(string(n,"contractVersion",16))) throw new WorkerException(422,"WORKER_CONTRACT_UNSUPPORTED");
    }
    public static Claim claim(JsonNode n) {
        fields(n,"contractVersion","eventId","eventType","eventSchemaVersion","meetingId","sourceMediaId","requestedByUserId","generation","claimRequestId");
        version(n);
        return new Claim(uuid(n,"eventId"),choice(n,"eventType","PROCESSING_JOB_QUEUED","PROCESSING_JOB_RETRY_REQUESTED"),
            (int)number(n,"eventSchemaVersion",1,2),uuid(n,"meetingId"),uuid(n,"sourceMediaId"),
            uuid(n,"requestedByUserId"),(int)number(n,"generation",0,Integer.MAX_VALUE),uuid(n,"claimRequestId"));
    }
    private static Owner owner(JsonNode n) {
        version(n); return new Owner(uuid(n,"eventId"),(int)number(n,"generation",0,Integer.MAX_VALUE),
            uuid(n,"executionStageRunId"),uuid(n,"claimToken"));
    }
    public static Owner renew(JsonNode n) {
        fields(n,"contractVersion","eventId","generation","executionStageRunId","claimToken"); return owner(n);
    }
    public static Complete complete(JsonNode n) {
        fields(n,"contractVersion","commandId","eventId","generation","executionStageRunId","claimToken","resultSha256","resultProducerStageRunId");
        return new Complete(uuid(n,"commandId"),owner(n),digest(n,"resultSha256"),uuid(n,"resultProducerStageRunId"));
    }
    public static Fail fail(JsonNode n) {
        fields(n,"contractVersion","commandId","eventId","generation","executionStageRunId","claimToken","phase","category","completedThrough","metrics");
        String phase=choice(n,"phase","SOURCE_DOWNLOAD","PREPROCESSING","CHUNK_PLANNING","ASR","COVERAGE_RECOVERY","RECONCILIATION","CORRECTION","RESULT_VALIDATION","RESULT_STORAGE","PUBLICATION","INTERRUPTED");
        String category=choice(n,"category","VALIDATION","DECODING","RESOURCE","TIMEOUT","PROVIDER","TRANSPORT","RATE_LIMIT","AUTHENTICATION","CONFIGURATION","CONTEXT_OVERFLOW","MALFORMED_OUTPUT","SUSPICIOUS_OUTPUT","INTEGRITY","NOT_FOUND","EMPTY_OUTPUT","CANCELLED");
        String through=n.get("completedThrough").isNull()?null:choice(n,"completedThrough","RECONCILIATION");
        var metrics=n.get("metrics"); require(metrics.isObject() && metrics.size()<=5);
        var values=new TreeMap<String,Long>();
        metrics.properties().forEach(p->{require(java.util.Set.of("sampleCount","chunkCount","retryCount","warningCount","unresolvedRegionCount").contains(p.getKey()));
            values.put(p.getKey(),number(metrics,p.getKey(),0,Integer.MAX_VALUE));});
        if (through!=null) require(java.util.Set.of("CORRECTION","RESULT_VALIDATION","RESULT_STORAGE","PUBLICATION").contains(phase)
            && values.getOrDefault("sampleCount",0L)>0 && values.get("sampleCount")<=230400000
            && values.containsKey("warningCount") && values.containsKey("unresolvedRegionCount"));
        return new Fail(uuid(n,"commandId"),owner(n),phase,category,through,Map.copyOf(values));
    }
    public static String fingerprint(Object command) { return sha256(MAPPER.writeValueAsBytes(command)); }
}
