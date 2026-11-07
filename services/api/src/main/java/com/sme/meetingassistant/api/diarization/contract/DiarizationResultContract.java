package com.sme.meetingassistant.api.diarization.contract;

import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Independent, transport/storage-free validation of untrusted diarization artifact bytes. */
public final class DiarizationResultContract {
    public static final String CONTRACT_VERSION = "1.0";
    public static final String RESULT_TYPE = "DIARIZATION_RESULT";
    public static final String PROCESSING_STAGE = "DIARIZING";
    public static final int MAX_RESULT_BYTES = 16_777_216;
    public static final int MAX_SPEAKERS = 1000;
    public static final int MAX_TURNS = 100_000;
    public static final int MAX_ASSIGNMENTS = 16_384;
    private static final BigInteger INTEGER_LIMIT = BigInteger.TEN.pow(4300);
    private static final Pattern DIGEST = Pattern.compile("[0-9a-f]{64}");
    private static final Pattern UUID_TEXT = Pattern.compile("[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}");
    private static final Pattern MODEL = Pattern.compile(
        "[A-Za-z0-9][A-Za-z0-9_.-]*(?:/[A-Za-z0-9][A-Za-z0-9_.-]*)*(?::[A-Za-z0-9][A-Za-z0-9_.-]*)?");
    private static final List<String> SECRET_PREFIXES = List.of("sk-", "sk_", "r8_", "hf_", "ghp_", "gho_",
        "ghu_", "ghs_", "ghr_", "github_pat_", "xoxb-", "xoxp-", "xoxa-", "xoxr-", "xoxs-", "akia", "asia", "eyj");
    private static final Set<String> SECRET_NAMES = Set.of("api_key", "api-key", "apikey", "access_token",
        "access-token", "authorization", "bearer", "password", "secret", "token");
    // This mapper is local to this contract; no change to HTTP or corrected-transcript parsing.
    private static final JsonMapper JSON = JsonMapper.builder(JsonFactory.builder()
        .streamReadConstraints(StreamReadConstraints.builder().maxNestingDepth(8).maxNumberLength(4300).build())
        .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build())
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();

    private DiarizationResultContract() { }

    /** Caller supplies these from an authenticated, Core-authoritative pinned snapshot/attempt. */
    public record ValidationContext(UUID processingJobId, UUID sourceMediaId, String sourceRevision,
            UUID transcriptId, BigInteger transcriptRevision, UUID producerStageRunId,
            BigInteger trustedDurationMs, List<BigInteger> expectedSegmentOrdinals) {
        public ValidationContext {
            require(processingJobId != null && sourceMediaId != null && transcriptId != null && producerStageRunId != null);
            require(sourceRevision != null && DIGEST.matcher(sourceRevision).matches());
            nonnegative(transcriptRevision); nonnegative(trustedDurationMs);
            require(expectedSegmentOrdinals != null && expectedSegmentOrdinals.size() <= MAX_ASSIGNMENTS);
            expectedSegmentOrdinals.forEach(DiarizationResultContract::nonnegative);
            require(new HashSet<>(expectedSegmentOrdinals).size() == expectedSegmentOrdinals.size());
            expectedSegmentOrdinals = List.copyOf(expectedSegmentOrdinals);
        }
    }

    public record Turn(BigInteger startMs, BigInteger endMs, String speakerLabel) { }
    public record Assignment(BigInteger ordinal, String speakerLabel) { }
    public record Diagnostics(int unknownAssignmentCount) { }

    /** Immutable data suitable for a future canonical persistence boundary; no writes occur here. */
    public record ValidatedResult(UUID processingJobId, UUID sourceMediaId, String sourceRevision,
            UUID transcriptId, BigInteger transcriptRevision, UUID producerStageRunId, String modelId,
            List<String> speakerLabels, List<Turn> turns, List<Assignment> assignments, Diagnostics diagnostics) {
        public ValidatedResult {
            speakerLabels = List.copyOf(speakerLabels);
            turns = List.copyOf(turns);
            assignments = List.copyOf(assignments);
        }
        public String contractVersion() { return CONTRACT_VERSION; }
        public String resultType() { return RESULT_TYPE; }
        public String status() { return "COMPLETED"; }
    }

    public static ValidatedResult validate(byte[] bytes, ValidationContext context, String expectedSha256) {
        try {
            // Bound bytes before hashing, decoding, or tree allocation.
            require(bytes != null && bytes.length > 0 && bytes.length <= MAX_RESULT_BYTES && context != null);
            require(expectedSha256 != null && DIGEST.matcher(expectedSha256).matches());
            require(expectedSha256.equals(sha256(bytes)));
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            require(!text.startsWith("\ufeff"));
            var root = JSON.readTree(text);
            fields(root, "contractVersion", "resultType", "processingJobId", "sourceMediaId", "sourceRevision",
                "transcriptId", "transcriptRevision", "producerStageRunId", "modelId", "status", "speakerLabels",
                "turns", "assignments", "diagnostics");
            require(CONTRACT_VERSION.equals(string(root.get("contractVersion")))
                && RESULT_TYPE.equals(string(root.get("resultType"))) && "COMPLETED".equals(string(root.get("status"))));
            UUID job = uuid(root.get("processingJobId")), media = uuid(root.get("sourceMediaId")),
                transcript = uuid(root.get("transcriptId")), producer = uuid(root.get("producerStageRunId"));
            String revision = string(root.get("sourceRevision"));
            require(DIGEST.matcher(revision).matches());
            BigInteger transcriptRevision = integer(root.get("transcriptRevision"));
            require(job.equals(context.processingJobId()) && media.equals(context.sourceMediaId())
                && revision.equals(context.sourceRevision()) && transcript.equals(context.transcriptId())
                && transcriptRevision.equals(context.transcriptRevision()) && producer.equals(context.producerStageRunId()));
            String model = string(root.get("modelId"));
            require(model.length() <= 256 && MODEL.matcher(model).matches() && !model.contains(".."));
            for (String part : model.toLowerCase(Locale.ROOT).split("[/:]")) {
                require(!SECRET_NAMES.contains(part) && SECRET_PREFIXES.stream().noneMatch(part::startsWith));
            }

            var labels = new ArrayList<String>();
            for (var node : array(root.get("speakerLabels"), MAX_SPEAKERS)) {
                String label = string(node); int number = labels.size() + 1;
                require(label.equals("SPEAKER_" + (number < 10 ? "0" : "") + number));
                labels.add(label);
            }
            var declared = new HashSet<>(labels); var referenced = new HashSet<String>();
            var turns = new ArrayList<Turn>(); BigInteger previous = BigInteger.valueOf(-1);
            for (var turn : array(root.get("turns"), MAX_TURNS)) {
                fields(turn, "startMs", "endMs", "speakerLabel");
                BigInteger start = integer(turn.get("startMs")), end = integer(turn.get("endMs"));
                require(start.compareTo(end) < 0 && end.compareTo(context.trustedDurationMs()) <= 0 && start.compareTo(previous) >= 0);
                String label = string(turn.get("speakerLabel")); require(declared.contains(label));
                turns.add(new Turn(start, end, label)); referenced.add(label); previous = start;
            }
            require(referenced.equals(declared));
            var wireAssignments = array(root.get("assignments"), MAX_ASSIGNMENTS);
            require(wireAssignments.size() == context.expectedSegmentOrdinals().size());
            var assignments = new ArrayList<Assignment>(); var ordinals = new HashSet<BigInteger>(); int unknown = 0;
            for (var assignment : wireAssignments) {
                fields(assignment, "ordinal", "speakerLabel");
                BigInteger ordinal = integer(assignment.get("ordinal"));
                require(ordinals.add(ordinal) && ordinal.equals(context.expectedSegmentOrdinals().get(assignments.size())));
                var node = assignment.get("speakerLabel"); String label = node.isNull() ? null : string(node);
                require(label == null || declared.contains(label));
                if (label == null) unknown++;
                assignments.add(new Assignment(ordinal, label));
            }
            var diagnostics = root.get("diagnostics"); fields(diagnostics, "unknownAssignmentCount");
            require(integer(diagnostics.get("unknownAssignmentCount")).equals(BigInteger.valueOf(unknown)));
            return new ValidatedResult(job, media, revision, transcript, transcriptRevision, producer, model,
                labels, turns, assignments, new Diagnostics(unknown));
        } catch (RuntimeException | CharacterCodingException invalid) {
            // Never expose artifact bytes or decoder/provider diagnostics via an exception cause.
            throw invalid();
        }
    }

    private static void fields(JsonNode value, String... expected) {
        require(value != null && value.isObject() && value.size() == expected.length);
        Set<String> names = Set.of(expected);
        value.properties().forEach(p -> require(names.contains(p.getKey())));
    }
    private static String string(JsonNode value) {
        require(value != null && value.isString()); return value.asString();
    }
    private static UUID uuid(JsonNode value) {
        String text = string(value); require(UUID_TEXT.matcher(text).matches()); return UUID.fromString(text);
    }
    private static JsonNode array(JsonNode value, int max) {
        require(value != null && value.isArray() && value.size() <= max); return value;
    }
    private static BigInteger integer(JsonNode value) {
        require(value != null && value.isIntegralNumber());
        BigInteger number = value.bigIntegerValue(); nonnegative(number); return number;
    }
    private static void nonnegative(BigInteger value) {
        require(value != null && value.signum() >= 0 && value.compareTo(INTEGER_LIMIT) < 0);
    }
    private static void require(boolean condition) { if (!condition) throw invalid(); }
    private static IllegalArgumentException invalid() {
        return new IllegalArgumentException("Diarization result contract validation failed.");
    }
    private static String sha256(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException("SHA-256 unavailable."); }
    }
}
