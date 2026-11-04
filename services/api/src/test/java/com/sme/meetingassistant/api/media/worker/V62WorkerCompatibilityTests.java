package com.sme.meetingassistant.api.media.worker;

import static org.assertj.core.api.Assertions.*;

import com.sme.meetingassistant.api.transcript.service.TranscriptCorrectionDigest;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

class V62WorkerCompatibilityTests {
    private byte[] resource(String name) throws Exception {
        try (var in = getClass().getResourceAsStream("/worker-v1/" + name)) {
            return in.readAllBytes();
        }
    }
    private CorrectedTranscript validate(byte[] bytes, String sha) {
        return CorrectedTranscript.validate(bytes, UUID.fromString("11111111-1111-4111-8111-111111111111"),
            UUID.fromString("22222222-2222-4222-8222-222222222222"), "a".repeat(64),
            UUID.fromString("33333333-3333-4333-8333-333333333333"), sha);
    }
    @Test void acceptsActualWorkerArtifact() throws Exception {
        byte[] bytes = resource("v62-worker.json");
        String sha = new String(resource("v62-worker.sha256"), StandardCharsets.US_ASCII).trim();
        var node = WorkerJson.MAPPER.readTree(bytes);
        var result = validate(bytes, sha);
        assertThat(WorkerJson.sha256(bytes)).isEqualTo(sha);
        assertThat(result.correctionDigest()).isEqualTo(TranscriptCorrectionDigest.sha256(result.mapping(null, null)))
            .isEqualTo(node.get("correctionProof").get("outputSha256").asString());
        assertThat(result.promptVersion()).isEqualTo("vi-whole-meeting-6.2.2");
        assertThat(node.get("provenance").get("configurationSha256").asString())
            .isEqualTo(WorkerJson.sha256(resource("v62-worker-config.json")));
        var components = node.get("provenance").get("components");
        assertThat(components.toString()).contains("\"name\":\"correction\",\"version\":\"6.2\"")
            .contains("\"name\":\"correction-mode\",\"version\":\"v62_edits\"")
            .contains("\"name\":\"correction-validator\",\"version\":\"vi-context-validation-6.2.1\"");
        assertThat(node.get("provenance").get("models").toString()).contains("test/corrector", "test/resolved", "openrouter");
        assertThat(result.segments().get(0).text()).contains("trầy xước rồi nói", "JWT");
    }
    @Test void rejectsTampering() throws Exception {
        byte[] original = resource("v62-worker.json");
        String sha = WorkerJson.sha256(original);
        var changed = (ObjectNode) WorkerJson.MAPPER.readTree(original);
        ((ObjectNode) changed.get("segments").get(0)).put("text", "nội dung bị thay đổi");
        byte[] bytes = WorkerJson.MAPPER.writeValueAsBytes(changed);
        assertThatThrownBy(() -> validate(bytes, sha)).isInstanceOf(WorkerException.class);
        assertThatThrownBy(() -> validate(bytes, WorkerJson.sha256(bytes))).isInstanceOf(WorkerException.class);
        changed = (ObjectNode) WorkerJson.MAPPER.readTree(original);
        var components = (ArrayNode) changed.get("provenance").get("components");
        components.add(components.get(0));
        byte[] duplicate = WorkerJson.MAPPER.writeValueAsBytes(changed);
        assertThatThrownBy(() -> validate(duplicate, WorkerJson.sha256(duplicate))).isInstanceOf(WorkerException.class);
        changed = (ObjectNode) WorkerJson.MAPPER.readTree(original);
        ((ObjectNode) changed.get("correctionProof")).put("contextScope", "PARTIAL");
        byte[] proof = WorkerJson.MAPPER.writeValueAsBytes(changed);
        assertThatThrownBy(() -> validate(proof, WorkerJson.sha256(proof))).isInstanceOf(WorkerException.class);
        changed = (ObjectNode) WorkerJson.MAPPER.readTree(original);
        changed.put("unsupported", true);
        byte[] extra = WorkerJson.MAPPER.writeValueAsBytes(changed);
        assertThatThrownBy(() -> validate(extra, WorkerJson.sha256(extra))).isInstanceOf(WorkerException.class);
    }
}
