package com.sme.meetingassistant.api.meetingintelligence.service;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Bounded, strict version-1 AI *data* contract. Never deserializes untrusted
 * status, actor, meeting ID or canonical row IDs. Producer fields are
 * validated as metadata but are not business authority.
 */
public record IntelligenceResultPayload(
    String resultType, UUID jobId, UUID stageRunId, UUID transcriptId,
    long contentRevision, UUID inputSnapshotId, String sourceSha256,
    String summary, List<Candidate> candidates, List<String> warnings,
    List<GroundingDiagnostic> diagnostics, String diagnosticsVersion,
    GroundingDiagnosticCounts diagnosticCounts, Producer producer
) {
    private static final Set<String> WARNING_CODES = AiQualityMetadata.ALLOWED;
    private static final String DIAGNOSTIC_VERSION = "1.0";
    private static final Set<String> DIAGNOSTIC_DISPOSITIONS = Set.of(
        "DISCARDED", "REPAIRED", "ACCEPTED", "REJECTED");
    private static final Set<String> LEGACY_DIAGNOSTIC_DISPOSITIONS = Set.of(
        "DISCARDED", "REPAIRED");
    private static final Set<String> DIAGNOSTIC_REASONS = Set.of(
        "INVALID_REFERENCE", "GROUNDING_FAILURE", "SUPPORTED", "UNSUPPORTED",
        "MISSING_REFERENCE", "STALE", "CONTRADICTED", "UNCERTAIN",
        "REVISION_MISMATCH");
    private static final Set<String> CLAIM_AUDIT_REASONS = Set.of(
        "SUPPORTED", "UNSUPPORTED", "INVALID_REFERENCE", "MISSING_REFERENCE",
        "STALE", "CONTRADICTED", "UNCERTAIN", "REVISION_MISMATCH",
        "GROUNDING_FAILURE");
    private static final Set<String> CLAIM_AUDIT_STAGES = Set.of(
        "GENERATING_SUMMARY", "EXTRACTING_DECISIONS", "EXTRACTING_ACTION_ITEMS");
    private static final Set<String> DIAGNOSTIC_RULES = Set.of(
        "SOURCE_IDENTITY", "REFERENCE_SHAPE", "REFERENCE_SEGMENT_NOT_FOUND", "REFERENCE_RANGE",
        "REFERENCE_DUPLICATE", "REFERENCE_OUTSIDE_WINDOW", "REFERENCE_NOT_ALLOWED", "TEXT_POLICY",
        "STATEMENT_NOT_GROUNDED", "QUALIFICATION_NOT_GROUNDED", "UNSUPPORTED_NUMBER",
        "AGREEMENT_UNSUPPORTED", "AGREEMENT_CONTRADICTED", "REDUCTION_COVERAGE", "REDUCTION_EMPTY",
        "CLAIM_SECTION", "CLAIM_NOT_MATCHED", "CLAIM_UNCERTAINTY", "CLAIM_CONFLICT_UNRESOLVED",
        "CLAIM_NOT_GROUNDED", "CLAIM_RECORD_GROUNDING", "CLAIM_QUALIFICATION_GROUNDING",
        "MATERIAL_CLAIM_COVERAGE");
    private static final Set<String> DIAGNOSTIC_ASSESSMENTS = Set.of(
        "SUPPORTED", "NEGATIVE_OR_TENTATIVE", "INCOMPLETE_CITATION",
        "POSSIBLE_VALIDATOR_FALSE_NEGATIVE", "UNSUPPORTED_MODEL_CLASSIFICATION");
    public record Candidate(String key, String content, List<UUID> evidenceSegmentIds,
                            String uncertainty) { }
    public record Producer(String provider, String model, String promptVersion) { }
    public record GroundingReference(UUID segmentId, int charStart, int charEnd) { }
    public record GroundingEvidence(UUID sourceSnapshotId, UUID transcriptId, long contentRevision,
                                    String sourceSha256, List<GroundingReference> references,
                                    String modelCategory, String statementSha256,
                                     int statementCharLength, String evidenceSha256,
                                     int evidenceCharLength, boolean affirmativeMarker,
                                     boolean negativeMarker, String assessment) { }
    public record GroundingDiagnosticCounts(String version, int accepted, int rejected,
                                            int discarded, int repaired, int total) { }
    public record GroundingDiagnostic(String disposition, String reason, String rule,
                                       Integer itemIndex, GroundingEvidence evidence,
                                       String diagnosticVersion, String stage, String fingerprint,
                                       List<String> warningCodes) {
        public GroundingDiagnostic {
            warningCodes = warningCodes == null ? List.of() : List.copyOf(warningCodes);
        }

        public GroundingDiagnostic(String disposition, String reason, String rule,
                Integer itemIndex, GroundingEvidence evidence) {
            this(disposition, reason, rule, itemIndex, evidence,
                null, null, null, List.of());
        }
    }

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
            exactOptional(result, Set.of("content", "warnings"),
                "diagnostics", "diagnosticsVersion", "diagnosticCounts");
        } else {
            exactOptional(result, Set.of("candidates", "warnings"),
                "diagnostics", "diagnosticsVersion", "diagnosticCounts");
        }
        List<String> warnings = new ArrayList<>();
        Set<String> uniqueWarnings = new HashSet<>();
        for (Object w : list(result.get("warnings"),WARNING_CODES.size())) {
            String code = string(w,1,40);
            if (!WARNING_CODES.contains(code) || !uniqueWarnings.add(code)) invalid();
            warnings.add(code);
        }
        List<GroundingDiagnostic> diagnostics = result.containsKey("diagnostics")
            ? parseDiagnostics(result.get("diagnostics")) : List.of();
        boolean hasDiagnosticMetadata = result.containsKey("diagnosticsVersion")
            || result.containsKey("diagnosticCounts");
        if (diagnostics.stream().anyMatch(diagnostic -> diagnostic.diagnosticVersion() != null)
                && !hasDiagnosticMetadata) invalid();
        String diagnosticsVersion = null;
        GroundingDiagnosticCounts diagnosticCounts;
        if (hasDiagnosticMetadata) {
            if (!result.containsKey("diagnosticsVersion")
                    || !result.containsKey("diagnosticCounts")) invalid();
            diagnosticsVersion = string(result.get("diagnosticsVersion"), 3, 8);
            if (!DIAGNOSTIC_VERSION.equals(diagnosticsVersion)) invalid();
            diagnosticCounts = parseCounts(result.get("diagnosticCounts"));
            verifyCounts(diagnosticCounts, diagnostics);
            for (GroundingDiagnostic diagnostic : diagnostics) {
                if (!diagnostic.warningCodes().stream().allMatch(warnings::contains)) invalid();
                if (diagnostic.diagnosticVersion() != null
                        && !DIAGNOSTIC_VERSION.equals(diagnostic.diagnosticVersion())) invalid();
            }
        } else {
            diagnosticCounts = counts("0.0", diagnostics);
        }
        String summary = null;
        List<Candidate> candidates = new ArrayList<>();
        if ("SUMMARY".equals(kind)) {
            summary=contentText(result.get("content"),20_000);
        } else {
            Set<String> keys=new HashSet<>();
            for (Object raw : list(result.get("candidates"),500)) {
                Map<String,Object> candidate=map(raw);
                exact(candidate,"candidateKey","content","evidenceSegmentIds","uncertainty");
                String key=string(candidate.get("candidateKey"),1,128);
                if (!key.matches("[A-Za-z0-9._-]+") || !keys.add(key)) invalid();
                String content=contentText(candidate.get("content"),5_000);
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
            List.copyOf(diagnostics),diagnosticsVersion,diagnosticCounts,attribution);
    }

    /** Parse the same bounded diagnostic array used by the action-item handoff. */
    public static List<GroundingDiagnostic> parseDiagnostics(JsonNode node) {
        if (node == null || node.isNull()) invalid();
        if (!node.isArray() || node.size() > 32) invalid();
        List<GroundingDiagnostic> diagnostics = new ArrayList<>();
        for (JsonNode item : node) diagnostics.add(parseDiagnostic(item));
        return List.copyOf(diagnostics);
    }

    private static List<GroundingDiagnostic> parseDiagnostics(Object value) {
        List<?> raw = list(value, 32);
        List<GroundingDiagnostic> diagnostics = new ArrayList<>();
        for (Object item : raw) diagnostics.add(parseDiagnostic(map(item)));
        return List.copyOf(diagnostics);
    }

    private static GroundingDiagnostic parseDiagnostic(JsonNode item) {
        if (item == null || !item.isObject()) invalid();
        boolean claim = item.has("diagnosticVersion") || item.has("stage")
                || item.has("fingerprint") || item.has("warningCodes");
        if (claim) {
            if (item.size() != 9 || !has(item, "diagnosticVersion", "stage", "disposition",
                    "reason", "rule", "itemIndex", "fingerprint", "warningCodes", "evidence")) invalid();
            String version = nodeString(item.get("diagnosticVersion"), 3, 8);
            String stage = nodeString(item.get("stage"), 1, 48);
            String disposition = nodeString(item.get("disposition"), 1, 16);
            String reason = nodeString(item.get("reason"), 1, 32);
            String rule = nullableNodeString(item.get("rule"), 64);
            Integer index = nullableNodeInteger(item.get("itemIndex"), 10_000);
            String fingerprint = nodeDigest(item.get("fingerprint"));
            List<String> warningCodes = nodeWarningCodes(item.get("warningCodes"));
            GroundingEvidence evidence = parseEvidence(item.get("evidence"));
            if (!DIAGNOSTIC_VERSION.equals(version)
                    || !CLAIM_AUDIT_STAGES.contains(stage)
                    || !Set.of("ACCEPTED", "REJECTED").contains(disposition)
                    || !CLAIM_AUDIT_REASONS.contains(reason)
                    || rule != null && !DIAGNOSTIC_RULES.contains(rule)) invalid();
            return new GroundingDiagnostic(disposition, reason, rule, index, evidence,
                version, stage, fingerprint, warningCodes);
        }
        if (item.size() != 5
                || !item.has("disposition") || !item.has("reason")
                || !item.has("rule") || !item.has("itemIndex")
                || !item.has("evidence")) invalid();
        String disposition = nodeString(item.get("disposition"), 16);
        String reason = nodeString(item.get("reason"), 32);
        String rule = nullableNodeString(item.get("rule"), 64);
        Integer index = nullableNodeInteger(item.get("itemIndex"), 10_000);
        GroundingEvidence evidence = parseEvidence(item.get("evidence"));
        if (!LEGACY_DIAGNOSTIC_DISPOSITIONS.contains(disposition)
                || !DIAGNOSTIC_REASONS.contains(reason)
                || rule != null && !DIAGNOSTIC_RULES.contains(rule)) invalid();
        return new GroundingDiagnostic(disposition, reason, rule, index, evidence);
    }

    private static GroundingDiagnostic parseDiagnostic(Map<String,Object> item) {
        boolean claim = item.containsKey("diagnosticVersion") || item.containsKey("stage")
            || item.containsKey("fingerprint") || item.containsKey("warningCodes");
        if (claim) {
            exact(item, "diagnosticVersion", "stage", "disposition", "reason", "rule",
                "itemIndex", "fingerprint", "warningCodes", "evidence");
            String version = string(item.get("diagnosticVersion"), 3, 8);
            String stage = string(item.get("stage"), 1, 48);
            String disposition = string(item.get("disposition"), 1, 16);
            String reason = string(item.get("reason"), 1, 32);
            String rule = nullableString(item.get("rule"), 64);
            Integer index = nullableInteger(item.get("itemIndex"), 10_000);
            String fingerprint = digest(item.get("fingerprint"));
            List<String> warningCodes = warningCodes(item.get("warningCodes"));
            GroundingEvidence evidence = parseEvidence(item.get("evidence"));
            if (!DIAGNOSTIC_VERSION.equals(version)
                    || !CLAIM_AUDIT_STAGES.contains(stage)
                    || !Set.of("ACCEPTED", "REJECTED").contains(disposition)
                    || !CLAIM_AUDIT_REASONS.contains(reason)
                    || rule != null && !DIAGNOSTIC_RULES.contains(rule)) invalid();
            return new GroundingDiagnostic(disposition, reason, rule, index, evidence,
                version, stage, fingerprint, warningCodes);
        }
        exact(item, "disposition", "reason", "rule", "itemIndex", "evidence");
        String disposition = string(item.get("disposition"), 1, 16);
        String reason = string(item.get("reason"), 1, 32);
        String rule = nullableString(item.get("rule"), 64);
        Integer index = nullableInteger(item.get("itemIndex"), 10_000);
        GroundingEvidence evidence = parseEvidence(item.get("evidence"));
        if (!LEGACY_DIAGNOSTIC_DISPOSITIONS.contains(disposition)
                || !DIAGNOSTIC_REASONS.contains(reason)
                || rule != null && !DIAGNOSTIC_RULES.contains(rule)) invalid();
        return new GroundingDiagnostic(disposition, reason, rule, index, evidence);
    }

    private static List<String> parseWarningCodes(Object value) {
        List<?> raw = list(value, WARNING_CODES.size());
        List<String> result = new ArrayList<>();
        Set<String> distinct = new HashSet<>();
        for (Object item : raw) {
            String code = string(item, 1, 40);
            if (!WARNING_CODES.contains(code) || !distinct.add(code)) invalid();
            result.add(code);
        }
        return List.copyOf(result);
    }

    private static List<String> warningCodes(Object value) {
        return parseWarningCodes(value);
    }

    private static List<String> nodeWarningCodes(JsonNode value) {
        if (value == null || !value.isArray() || value.size() > WARNING_CODES.size()) invalid();
        List<String> result = new ArrayList<>();
        Set<String> distinct = new HashSet<>();
        for (JsonNode item : value) {
            String code = nodeString(item, 1, 40);
            if (!WARNING_CODES.contains(code) || !distinct.add(code)) invalid();
            result.add(code);
        }
        return List.copyOf(result);
    }

    private static GroundingDiagnosticCounts parseCounts(Object value) {
        Map<String,Object> counts = map(value);
        exact(counts, "version", "accepted", "rejected", "discarded", "repaired", "total");
        return new GroundingDiagnosticCounts(
            string(counts.get("version"), 3, 8),
            boundedInteger(counts.get("accepted"), 32),
            boundedInteger(counts.get("rejected"), 32),
            boundedInteger(counts.get("discarded"), 32),
            boundedInteger(counts.get("repaired"), 32),
            boundedInteger(counts.get("total"), 32));
    }

    private static GroundingDiagnosticCounts counts(
            String version, List<GroundingDiagnostic> diagnostics) {
        int accepted = 0;
        int rejected = 0;
        int discarded = 0;
        int repaired = 0;
        for (GroundingDiagnostic diagnostic : diagnostics) {
            switch (diagnostic.disposition()) {
                case "ACCEPTED" -> accepted++;
                case "REJECTED" -> rejected++;
                case "DISCARDED" -> discarded++;
                case "REPAIRED" -> repaired++;
                default -> invalid();
            }
        }
        return new GroundingDiagnosticCounts(version, accepted, rejected, discarded, repaired,
            diagnostics.size());
    }

    private static void verifyCounts(
            GroundingDiagnosticCounts supplied, List<GroundingDiagnostic> diagnostics) {
        GroundingDiagnosticCounts expected = counts(supplied.version(), diagnostics);
        if (!supplied.equals(expected)) invalid();
    }

    private static GroundingEvidence parseEvidence(Object value) {
        if (value == null) return null;
        Map<String,Object> evidence = map(value);
        exact(evidence, "sourceSnapshotId", "transcriptId", "contentRevision", "sourceSha256",
            "references", "modelCategory", "statementSha256", "statementCharLength",
            "evidenceSha256", "evidenceCharLength", "affirmativeMarker",
            "negativeMarker", "assessment");
        List<?> rawReferences = list(evidence.get("references"), 16);
        if (rawReferences.isEmpty()) invalid();
        List<GroundingReference> references = new ArrayList<>();
        Set<GroundingReference> distinct = new HashSet<>();
        for (Object raw : rawReferences) {
            Map<String,Object> reference = map(raw);
            exact(reference, "segmentId", "charStart", "charEnd");
            int start = boundedInteger(reference.get("charStart"), 8_388_608);
            int end = boundedInteger(reference.get("charEnd"), 8_388_608);
            GroundingReference parsed = new GroundingReference(uuid(reference.get("segmentId")),
                start, end);
            if (start > end || !distinct.add(parsed)) invalid();
            references.add(parsed);
        }
        String modelCategory = string(evidence.get("modelCategory"), 1, 32);
        String assessment = string(evidence.get("assessment"), 1, 64);
        int statementLength = boundedInteger(evidence.get("statementCharLength"), 2_000);
        int evidenceLength = boundedInteger(evidence.get("evidenceCharLength"), 8_388_608);
        if (!modelCategory.matches("[A-Z_]{1,32}") || !DIAGNOSTIC_ASSESSMENTS.contains(assessment)
                || !(evidence.get("affirmativeMarker") instanceof Boolean)
                || !(evidence.get("negativeMarker") instanceof Boolean)) invalid();
        return new GroundingEvidence(
            uuid(evidence.get("sourceSnapshotId")), uuid(evidence.get("transcriptId")),
            boundedLong(evidence.get("contentRevision")), digest(evidence.get("sourceSha256")),
            List.copyOf(references), modelCategory, digest(evidence.get("statementSha256")),
            statementLength, digest(evidence.get("evidenceSha256")), evidenceLength,
            (Boolean)evidence.get("affirmativeMarker"), (Boolean)evidence.get("negativeMarker"),
            assessment);
    }

    private static GroundingEvidence parseEvidence(JsonNode value) {
        if (value == null || value.isNull()) return null;
        if (!value.isObject() || value.size() != 13) invalid();
        Set<String> expected = Set.of("sourceSnapshotId", "transcriptId", "contentRevision",
            "sourceSha256", "references", "modelCategory", "statementSha256",
            "statementCharLength", "evidenceSha256", "evidenceCharLength",
            "affirmativeMarker", "negativeMarker", "assessment");
        Set<String> actual = new HashSet<>();
        value.properties().forEach(property -> actual.add(property.getKey()));
        if (!actual.equals(expected)) invalid();
        JsonNode referencesNode = value.get("references");
        if (referencesNode == null || !referencesNode.isArray()
                || referencesNode.size() < 1 || referencesNode.size() > 16) invalid();
        List<GroundingReference> references = new ArrayList<>();
        Set<GroundingReference> distinct = new HashSet<>();
        for (JsonNode reference : referencesNode) {
            if (!reference.isObject() || reference.size() != 3
                    || !reference.has("segmentId") || !reference.has("charStart")
                    || !reference.has("charEnd")) invalid();
            int start = nodeInteger(reference.get("charStart"), 8_388_608);
            int end = nodeInteger(reference.get("charEnd"), 8_388_608);
            GroundingReference parsed = new GroundingReference(nodeUuid(reference.get("segmentId")),
                start, end);
            if (start > end || !distinct.add(parsed)) invalid();
            references.add(parsed);
        }
        String modelCategory = nodeString(value.get("modelCategory"), 32);
        String assessment = nodeString(value.get("assessment"), 64);
        if (!modelCategory.matches("[A-Z_]{1,32}") || !DIAGNOSTIC_ASSESSMENTS.contains(assessment)
                || !value.get("affirmativeMarker").isBoolean()
                || !value.get("negativeMarker").isBoolean()) invalid();
        return new GroundingEvidence(
            nodeUuid(value.get("sourceSnapshotId")), nodeUuid(value.get("transcriptId")),
            nodeLong(value.get("contentRevision")), nodeDigest(value.get("sourceSha256")),
            List.copyOf(references), modelCategory, nodeDigest(value.get("statementSha256")),
            nodeInteger(value.get("statementCharLength"), 2_000),
            nodeDigest(value.get("evidenceSha256")),
            nodeInteger(value.get("evidenceCharLength"), 8_388_608),
            value.get("affirmativeMarker").booleanValue(), value.get("negativeMarker").booleanValue(),
            assessment);
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
    private static void exactOptional(Map<String,Object> value, Set<String> required,
            String... optional) {
        Set<String> allowed = new HashSet<>(required);
        allowed.addAll(Set.of(optional));
        if (!value.keySet().containsAll(required)
                || value.keySet().stream().anyMatch(key -> !allowed.contains(key))) invalid();
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
    /**
     * Result *content* is Vietnamese prose, not an identifier. Preserve LF/TAB,
     * normalize Windows CRLF to LF, and reject standalone CR, all other ISO
     * control characters, empty/blank and overlong content. Never trim or
     * rewrite the original Unicode characters (including combining accents).
     *
     * Size is checked before normalization against JSON Schema's character
     * limit, so CRLF cannot bypass maxLength by collapsing to LF.
     */
    private static String contentText(Object value, int max) {
        if (!(value instanceof String text) || text.isBlank()
                || text.codePointCount(0, text.length()) > max) {
            throw new IllegalArgumentException("Intelligence result contains invalid text.");
        }
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '\r') {
                if (i + 1 == text.length() || text.charAt(++i) != '\n') {
                    throw new IllegalArgumentException("Intelligence result contains invalid text.");
                }
            } else if (c != '\n' && c != '\t' && Character.isISOControl(c)) {
                throw new IllegalArgumentException("Intelligence result contains invalid text.");
            }
        }
        return text.replace("\r\n", "\n");
    }

    private static long integer(Object value) {
        if (!(value instanceof Integer || value instanceof Long)) { invalid(); }
        long n=((Number)value).longValue();
        if (n<0) invalid();
        return n;
    }
    private static int boundedInteger(Object value, int maximum) {
        long n=integer(value);
        if (n>maximum) invalid();
        return (int)n;
    }
    private static long boundedLong(Object value) {
        return integer(value);
    }
    private static String nullableString(Object value, int max) {
        if (value == null) return null;
        return string(value,1,max);
    }
    private static Integer nullableInteger(Object value, int max) {
        if (value == null) return null;
        return boundedInteger(value,max);
    }
    private static String digest(Object value) {
        String valueText=string(value,64,64);
        if (!valueText.matches("[0-9a-f]{64}")) invalid();
        return valueText;
    }
    private static String nodeString(JsonNode value, int max) {
        return nodeString(value, 1, max);
    }
    private static String nodeString(JsonNode value, int min, int max) {
        if (value == null || !value.isString()) invalid();
        return string(value.asString(),min,max);
    }
    private static String nullableNodeString(JsonNode value, int max) {
        if (value == null || value.isNull()) return null;
        return nodeString(value,max);
    }
    private static Integer nullableNodeInteger(JsonNode value, int max) {
        if (value == null || value.isNull()) return null;
        return nodeInteger(value,max);
    }
    private static int nodeInteger(JsonNode value, int max) {
        if (value == null || !value.isIntegralNumber() || !value.canConvertToInt()) invalid();
        int number=value.intValue();
        if (number<0 || number>max) invalid();
        return number;
    }
    private static long nodeLong(JsonNode value) {
        if (value == null || !value.isIntegralNumber() || !value.canConvertToLong()
                || value.longValue()<0) invalid();
        return value.longValue();
    }
    private static UUID nodeUuid(JsonNode value) {
        if (value == null || !value.isString()) invalid();
        return uuid(value.asString());
    }
    private static String nodeDigest(JsonNode value) {
        if (value == null || !value.isString()) invalid();
        return digest(value.asString());
    }
    private static boolean has(JsonNode value, String... keys) {
        for (String key : keys) if (!value.has(key)) return false;
        return true;
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
