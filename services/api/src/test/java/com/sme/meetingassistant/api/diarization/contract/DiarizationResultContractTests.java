package com.sme.meetingassistant.api.diarization.contract;

import static org.assertj.core.api.Assertions.*;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

class DiarizationResultContractTests {
    private static final JsonMapper JSON = JsonMapper.builder(JsonFactory.builder()
        .streamReadConstraints(StreamReadConstraints.builder().maxNumberLength(4300).build()).build()).build();
    private static final JsonNode FIXTURES = fixtures();

    private static JsonNode fixtures() {
        try {
            // Maven basedir works both with -f from root and from services/api.
            Path module = Path.of(System.getProperty("basedir", ".")).toAbsolutePath();
            return JSON.readTree(Files.readString(module.resolve("../../contracts/DIARIZATION_RESULT_V1.fixtures.json")));
        } catch (Exception e) { throw new IllegalStateException(e); }
    }

    private static Stream<Arguments> cases(String group) {
        var cases = new ArrayList<Arguments>();
        for (var c : FIXTURES.get(group)) cases.add(Arguments.of(c.get("name").asString(), c));
        return cases.stream();
    }
    static Stream<Arguments> validCases() { return cases("valid"); }
    static Stream<Arguments> invalidCases() { return cases("invalid"); }

    private static void change(JsonNode root, String pointer, JsonNode value, boolean remove) {
        int slash = pointer.lastIndexOf('/');
        var parent = slash == 0 ? root : root.at(pointer.substring(0, slash));
        String key = pointer.substring(slash + 1);
        if (parent instanceof ObjectNode object) {
            if (remove) object.remove(key); else object.set(key, value);
        } else {
            var array = (ArrayNode) parent;
            if (remove) array.remove(Integer.parseInt(key)); else array.set(Integer.parseInt(key), value);
        }
    }

    private static String sha(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
    private record Vector(byte[] bytes, JsonNode snapshot, String digest) { }

    private static Vector expand(JsonNode c) throws Exception {
        ObjectNode payload = (ObjectNode) FIXTURES.get("base").deepCopy();
        ObjectNode snapshot = (ObjectNode) FIXTURES.get("context").deepCopy();
        if (c.has("set")) c.get("set").properties().forEach(p -> change(payload, p.getKey(), p.getValue(), false));
        if (c.has("contextSet")) c.get("contextSet").properties().forEach(p -> change(snapshot, p.getKey(), p.getValue(), false));
        if (c.has("remove")) change(payload, c.get("remove").asString(), null, true);
        if (c.has("modelLength")) payload.put("modelId", "m".repeat(c.get("modelLength").intValue()));
        if (c.has("integerDigits")) {
            var revision = BigInteger.TEN.pow(c.get("integerDigits").intValue() - 1);
            if (c.get("integerDigits").intValue() <= 4300) snapshot.put("transcriptRevision", revision);
            payload.put("transcriptRevision", c.get("integerDigits").intValue() > 4300 ? BigInteger.valueOf(7) : revision);
        }
        if (c.has("speakerCount")) {
            var labels = payload.putArray("speakerLabels"); var turns = payload.putArray("turns");
            for (int i = 0; i < c.get("speakerCount").intValue(); i++) {
                String label = "SPEAKER_" + (i + 1 < 10 ? "0" : "") + (i + 1);
                labels.add(label);
                turns.addObject().put("startMs", i).put("endMs", i + 1).put("speakerLabel", label);
            }
        }
        if (c.has("turnCount")) {
            var turn = payload.get("turns").get(0); var turns = payload.putArray("turns");
            for (int i = 0; i < c.get("turnCount").intValue(); i++) turns.add(turn);
        }
        if (c.has("assignmentCount")) {
            int count = c.get("assignmentCount").intValue();
            var ordinals = snapshot.putArray("expectedSegmentOrdinals"); var assignments = payload.putArray("assignments");
            for (int i = 0; i < count; i++) { ordinals.add(i); assignments.addObject().put("ordinal", i).putNull("speakerLabel"); }
            ((ObjectNode) payload.get("diagnostics")).put("unknownAssignmentCount", count);
        }
        String raw = JSON.writeValueAsString(payload);
        if (c.has("integerDigits") && c.get("integerDigits").intValue() > 4300) {
            raw = raw.replace("\"transcriptRevision\":7", "\"transcriptRevision\":1" + "0".repeat(c.get("integerDigits").intValue() - 1));
        }
        if (c.has("rawReplace")) raw = raw.replace(c.get("rawReplace").get(0).asString(), c.get("rawReplace").get(1).asString());
        if (c.has("raw")) raw = c.get("raw").asString();
        byte[] bytes = c.has("rawHex") ? HexFormat.of().parseHex(c.get("rawHex").asString()) : raw.getBytes(StandardCharsets.UTF_8);
        if (c.has("paddedBytes")) {
            int old = bytes.length; bytes = Arrays.copyOf(bytes, c.get("paddedBytes").intValue());
            Arrays.fill(bytes, old, bytes.length, (byte) ' ');
        }
        return new Vector(bytes, snapshot, c.has("expectedDigest") ? c.get("expectedDigest").asString() : sha(bytes));
    }

    private static DiarizationResultContract.ValidationContext context(JsonNode n) {
        var ordinals = new ArrayList<BigInteger>();
        for (var ordinal : n.get("expectedSegmentOrdinals")) ordinals.add(ordinal.bigIntegerValue());
        return new DiarizationResultContract.ValidationContext(
            UUID.fromString(n.get("processingJobId").asString()), UUID.fromString(n.get("sourceMediaId").asString()),
            n.get("sourceRevision").asString(), UUID.fromString(n.get("transcriptId").asString()),
            n.get("transcriptRevision").bigIntegerValue(), UUID.fromString(n.get("producerStageRunId").asString()),
            n.get("trustedDurationMs").bigIntegerValue(), ordinals);
    }

    @ParameterizedTest(name = "{0}") @MethodSource("validCases")
    void acceptsSharedFixtures(String name, JsonNode c) throws Exception {
        var v = expand(c); var trusted = context(v.snapshot());
        var result = DiarizationResultContract.validate(v.bytes(), trusted, v.digest());
        var original = JSON.readTree(v.bytes());
        assertThat(result.contractVersion()).isEqualTo("1.0");
        assertThat(result.resultType()).isEqualTo("DIARIZATION_RESULT");
        assertThat(result.status()).isEqualTo("COMPLETED");
        assertThat(result.modelId()).isEqualTo(original.get("modelId").asString());
        assertThat(result.assignments().stream().map(DiarizationResultContract.Assignment::ordinal).toList())
            .isEqualTo(trusted.expectedSegmentOrdinals());
        assertThat(result.turns()).hasSize(original.get("turns").size());
        for (int i = 0; i < result.turns().size(); i++) {
            var turn = result.turns().get(i); var wire = original.get("turns").get(i);
            assertThat(turn.startMs()).isEqualTo(wire.get("startMs").bigIntegerValue());
            assertThat(turn.endMs()).isEqualTo(wire.get("endMs").bigIntegerValue());
            assertThat(turn.speakerLabel()).isEqualTo(wire.get("speakerLabel").asString());
        }
        assertThat(result.diagnostics().unknownAssignmentCount()).isEqualTo(
            (int) result.assignments().stream().filter(a -> a.speakerLabel() == null).count());
        assertThatThrownBy(() -> result.speakerLabels().add("SPEAKER_02")).isInstanceOf(UnsupportedOperationException.class);
    }

    @ParameterizedTest(name = "{0}") @MethodSource("invalidCases")
    void rejectsSharedFixtures(String name, JsonNode c) throws Exception {
        var v = expand(c);
        assertThatThrownBy(() -> DiarizationResultContract.validate(v.bytes(), context(v.snapshot()), v.digest()))
            .isInstanceOf(IllegalArgumentException.class).hasMessage("Diarization result contract validation failed.");
    }

    @Test void integrityUsesExactBytesAndContextIsDefensivelyCopied() throws Exception {
        var v = expand(JSON.createObjectNode());
        byte[] changed = Arrays.copyOf(v.bytes(), v.bytes().length + 1); changed[changed.length - 1] = '\n';
        assertThatThrownBy(() -> DiarizationResultContract.validate(changed, context(v.snapshot()), v.digest()))
            .isInstanceOf(IllegalArgumentException.class);
        var source = new ArrayList<>(List.of(BigInteger.ONE));
        var base = context(v.snapshot());
        var trusted = new DiarizationResultContract.ValidationContext(base.processingJobId(), base.sourceMediaId(),
            base.sourceRevision(), base.transcriptId(), base.transcriptRevision(), base.producerStageRunId(),
            base.trustedDurationMs(), source);
        source.clear();
        assertThat(trusted.expectedSegmentOrdinals()).containsExactly(BigInteger.ONE);
        assertThatThrownBy(() -> new DiarizationResultContract.ValidationContext(base.processingJobId(), base.sourceMediaId(),
            base.sourceRevision(), base.transcriptId(), BigInteger.valueOf(-1), base.producerStageRunId(),
            base.trustedDurationMs(), List.of())).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new DiarizationResultContract.ValidationContext(base.processingJobId(), base.sourceMediaId(),
            base.sourceRevision(), base.transcriptId(), base.transcriptRevision(), base.producerStageRunId(),
            base.trustedDurationMs(), List.of(BigInteger.ONE, BigInteger.ONE))).isInstanceOf(IllegalArgumentException.class);
    }
}
