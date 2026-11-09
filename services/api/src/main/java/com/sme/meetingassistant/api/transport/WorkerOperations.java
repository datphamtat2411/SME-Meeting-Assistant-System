package com.sme.meetingassistant.api.transport;

import java.util.Set;
import java.util.regex.Pattern;

/** V1 operation grants only. No controllers, leases or business responses. */
public final class WorkerOperations {
    private WorkerOperations() {}
    private static final String UUID = "[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}";
    private static final String BASE = "/internal/v1/worker/processing-jobs/" + UUID + "/transcription/";
    private static final Pattern COMMAND = Pattern.compile(BASE + "(claim|renew|complete|fail)");
    private static final Pattern DELIVERY = Pattern.compile(BASE + "deliveries/" + UUID);
    private static final String DIARIZATION = "/internal/v1/worker/processing-jobs/" + UUID + "/diarization/";
    private static final Pattern DIARIZATION_COMMAND = Pattern.compile(DIARIZATION + "(claim|snapshot|renew|complete|fail)");
    private static final Pattern DIARIZATION_DELIVERY = Pattern.compile(DIARIZATION + "deliveries/" + UUID);
    private static final String INTELLIGENCE="/internal/v1/worker/processing-jobs/"+UUID+"/intelligence/";
    private static final Pattern INTELLIGENCE_COMMAND=Pattern.compile(INTELLIGENCE+"(claim|renew|fail)");
    private static final Pattern INTELLIGENCE_DELIVERY=Pattern.compile(INTELLIGENCE+"deliveries/"+UUID);
    private static final Set<String> INTELLIGENCE_GRANTS=Set.of("intelligence.claim","intelligence.renew","intelligence.fail","intelligence.read-delivery");
    private static final String KNOWLEDGE="/internal/v1/worker/knowledge-indexing/deliveries/" + UUID + "/";
    private static final Pattern KNOWLEDGE_COMMAND=Pattern.compile(KNOWLEDGE+"(claim|renew|snapshot|result)");
    private static final Pattern KNOWLEDGE_DELIVERY=Pattern.compile(
        "/internal/v1/worker/knowledge-indexing/deliveries/" + UUID);
    private static final Set<String> KNOWLEDGE_GRANTS=Set.of("knowledge.claim","knowledge.renew",
        "knowledge.snapshot","knowledge.result","knowledge.read-delivery");
    private static final Set<String> GRANTS = Set.of("transcription.claim", "transcription.read-delivery",
        "transcription.renew", "transcription.complete", "transcription.fail",
        "diarization.claim", "diarization.snapshot", "diarization.renew", "diarization.complete", "diarization.fail", "diarization.read-delivery");

    public static String operation(String method, String path) {
        var command = COMMAND.matcher(path);
        if ("POST".equals(method) && command.matches()) return "transcription." + command.group(1);
        if ("GET".equals(method) && DELIVERY.matcher(path).matches()) return "transcription.read-delivery";
        var diarization = DIARIZATION_COMMAND.matcher(path);
        if ("POST".equals(method) && diarization.matches()) return "diarization." + diarization.group(1);
        if ("GET".equals(method) && DIARIZATION_DELIVERY.matcher(path).matches()) return "diarization.read-delivery";
        var intelligence=INTELLIGENCE_COMMAND.matcher(path);
        if("POST".equals(method) && intelligence.matches()) return "intelligence."+intelligence.group(1);
        if("GET".equals(method) && INTELLIGENCE_DELIVERY.matcher(path).matches()) return "intelligence.read-delivery";
        var knowledge=KNOWLEDGE_COMMAND.matcher(path);
        if("POST".equals(method) && knowledge.matches()) return "knowledge." + knowledge.group(1);
        if("GET".equals(method) && KNOWLEDGE_DELIVERY.matcher(path).matches()) return "knowledge.read-delivery";
        return null;
    }

    public static boolean allowed(String principal, String operation) {
        return operation!=null && ("urn:sme:service:ai-worker".equals(principal) && GRANTS.contains(operation)
            || "urn:sme:service:mi-worker".equals(principal) && INTELLIGENCE_GRANTS.contains(operation)
            || "urn:sme:service:knowledge-worker".equals(principal) && KNOWLEDGE_GRANTS.contains(operation));
    }
}
