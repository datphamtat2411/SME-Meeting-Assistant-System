package com.sme.meetingassistant.api.meetingintelligence.service;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;

/**
 * Bounded, strict version-1 AI *data* contract. Never deserializes untrusted
 * status, actor, meeting ID or canonical row IDs. Producer fields are
 * validated as metadata but are not business authority.
 */
public record IntelligenceResultPayload(
    String resultType, UUID jobId, UUID stageRunId, UUID transcriptId,
    long contentRevision, UUID inputSnapshotId, String sourceSha256,
    String summary, List<Candidate> candidates, List<String> warnings, Producer producer
) {
    private static final Set<String> WARNING_CODES = Set.of(
        "INCOMPLETE_COVERAGE", "UNRESOLVED_EVIDENCE", "SUSPICIOUS_EVIDENCE",
        "SOURCE_QUALITY_WARNING"
    );
    public record Candidate(String key, String content, List<UUID> evidenceSegmentIds,
                            String uncertainty) { }
    public record Producer(String provider, String model, String promptVersion) { }

    public static IntelligenceResultPayload parse(byte[] bytes, ObjectMapper mapper) {
        final Map<String,Object> root;
        try {
            @SuppressWarnings("unchecked")
            Map<String,Object> decoded = mapper.readValue(bytes, Map.class);
            root = decoded;
        } catch (JacksonException | ClassCastException ex) {
            throw new IllegalArgumentException("Invalid intelligence JSON payload.", ex);
        }
        exact(root, "schemaVersion","resultType","processingJobId","stageRunId",
            "source","producer","result");
        if (!"1.0".equals(root.get("schemaVersion"))) invalid();
        String kind = string(root.get("resultType"),1,32);
        if (!Set.of("SUMMARY","DECISION_EXTRACTION").contains(kind)) invalid();
        UUID job=uuid(root.get("processingJobId"));
        UUID stage=uuid(root.get("stageRunId"));

        Map<String,Object> source=map(root.get("source"));
        exact(source,"transcriptId","contentRevision","inputSnapshotId","sha256");
        UUID transcript=uuid(source.get("transcriptId"));
        long revision=integer(source.get("contentRevision"));
        UUID snapshot=uuid(source.get("inputSnapshotId"));
        String sha=string(source.get("sha256"),64,64);
        if (!sha.matches("[0-9a-f]{64}")) invalid();

        Map<String,Object> producer=map(root.get("producer"));
        optional(producer, Set.of("provider"), Set.of("model","promptVersion"));
        string(producer.get("model"),1,160);
        string(producer.get("promptVersion"),1,80);
        String provider=producer.containsKey("provider")
            ? string(producer.get("provider"),1,80) : null;
        Producer attribution=new Producer(provider,
            string(producer.get("model"),1,160),
            string(producer.get("promptVersion"),1,80));

        Map<String,Object> result=map(root.get("result"));
        if ("SUMMARY".equals(kind)) {
            exact(result,"content","warnings");
        } else {
            exact(result,"candidates","warnings");
        }
        List<String> warnings = new ArrayList<>();
        Set<String> uniqueWarnings = new HashSet<>();
        for (Object w : list(result.get("warnings"),4)) {
            String code = string(w,1,40);
            if (!WARNING_CODES.contains(code) || !uniqueWarnings.add(code)) invalid();
            warnings.add(code);
        }
        String summary = null;
        List<Candidate> candidates = new ArrayList<>();
        if ("SUMMARY".equals(kind)) {
            summary=string(result.get("content"),1,20_000);
        } else {
            Set<String> keys=new HashSet<>();
            for (Object raw : list(result.get("candidates"),500)) {
                Map<String,Object> candidate=map(raw);
                exact(candidate,"candidateKey","content","evidenceSegmentIds","uncertainty");
                String key=string(candidate.get("candidateKey"),1,128);
                if (!key.matches("[A-Za-z0-9._-]+") || !keys.add(key)) invalid();
                String content=string(candidate.get("content"),1,5_000);
                String uncertainty=string(candidate.get("uncertainty"),1,8);
                if (!Set.of("NONE","LOW","MATERIAL").contains(uncertainty)) invalid();
                List<UUID> ids=new ArrayList<>();
                Set<UUID> distinct=new HashSet<>();
                for (Object rawId : list(candidate.get("evidenceSegmentIds"),50)) {
                    UUID id=uuid(rawId);
                    if (!distinct.add(id)) invalid();
                    ids.add(id);
                }
                if (ids.isEmpty()) invalid();
                candidates.add(new Candidate(key,content,List.copyOf(ids),uncertainty));
            }
        }
        return new IntelligenceResultPayload(kind,job,stage,transcript,revision,
            snapshot,sha,summary,List.copyOf(candidates),List.copyOf(warnings),
            attribution);
    }

    private static Map<String,Object> map(Object value) {
        if (!(value instanceof Map<?,?> raw)) { invalid(); }
        @SuppressWarnings("unchecked") Map<String,Object> result=(Map<String,Object>)value;
        if (result.keySet().stream().anyMatch(k -> !(k instanceof String))) invalid();
        return result;
    }
    private static void exact(Map<String,Object> value, String... required) {
        if (!value.keySet().equals(Set.of(required))) invalid();
    }
    private static void optional(Map<String,Object> value, Set<String> optional, Set<String> required) {
        if (!value.keySet().containsAll(required)
                || !Set.copyOf(required).stream().allMatch(value::containsKey)
                || value.keySet().stream().anyMatch(k->!required.contains(k)&&!optional.contains(k))) invalid();
    }
    private static String string(Object value,int min,int max) {
        if (!(value instanceof String str) || str.length()<min || str.length()>max || str.isBlank()
                || str.chars().anyMatch(Character::isISOControl)) {
            throw new IllegalArgumentException("Intelligence result contains invalid text.");
        }
        return str;
    }
    private static long integer(Object value) {
        if (!(value instanceof Integer || value instanceof Long)) { invalid(); }
        long n=((Number)value).longValue();
        if (n<0) invalid();
        return n;
    }
    private static UUID uuid(Object value) {
        String str=string(value,36,36);
        if (!str.matches("[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")) invalid();
        return UUID.fromString(str);
    }
    private static List<?> list(Object value,int max) {
        if (!(value instanceof List<?> result) || result.size()>max) {
            throw new IllegalArgumentException("Intelligence result array is invalid.");
        }
        return result;
    }
    private static void invalid() {
        throw new IllegalArgumentException("Intelligence result contract validation failed.");
    }
}
