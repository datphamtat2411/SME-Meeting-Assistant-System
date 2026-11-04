package com.sme.meetingassistant.api.media.worker;

import static org.assertj.core.api.Assertions.*;
import java.util.UUID;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import tools.jackson.databind.node.ObjectNode;

class CorrectedTranscriptTests {
    static ObjectNode fixture() throws Exception {
        try(var input=CorrectedTranscriptTests.class.getResourceAsStream("/worker-v1/corrected-transcript.json")) {
            return (ObjectNode)WorkerJson.MAPPER.readTree(input.readAllBytes());
        }
    }
    static CorrectedTranscript validate(ObjectNode node) {
        byte[] bytes=WorkerJson.MAPPER.writeValueAsBytes(node);
        return CorrectedTranscript.validate(bytes,UUID.fromString("11111111-1111-4111-8111-111111111111"),
            UUID.fromString("44444444-4444-4444-8444-444444444444"),"a".repeat(64),
            UUID.fromString("22222222-2222-4222-8222-222222222222"),WorkerJson.sha256(bytes));
    }
    @Test void acceptsGoldenAndPreservesTextAndProvenance() throws Exception {
        var node=fixture(); var result=validate(node);
        assertThat(result.segments().get(1).text()).isEqualTo("Chốt lịch họp.");
        assertThat(result.correctionDigest()).isEqualTo("dfa8c6d7a8a5297c28f1b4f7f4fcea73a0c21b04fe4e3377a5b9ad29e9acb70a");
        assertThat(result.metadata().get("provenance")).isEqualTo(node.get("provenance"));
        byte[] pretty=WorkerJson.MAPPER.writerWithDefaultPrettyPrinter().writeValueAsBytes(node);
        assertThat(WorkerJson.sha256(pretty)).isNotEqualTo(WorkerJson.sha256(WorkerJson.MAPPER.writeValueAsBytes(node)));
        assertThat(CorrectedTranscript.validate(pretty,result.jobId(),result.mediaId(),result.sourceRevision(),result.producerId(),WorkerJson.sha256(pretty)).correctionDigest())
            .isEqualTo(result.correctionDigest());
    }
    static Stream<String> invalidMutations() {
        return Stream.of("unknown","version","raw","failed","source","revision","producer","sampleRate","sampleCount","duration",
            "ordinal","reverse","outOfBounds","empty","blank","control","surrogate","longText","coverage","quality","recovery",
            "warnings","provenance","model","proof","coercion","duplicateComponent","extraSegmentField");
    }
    @ParameterizedTest @MethodSource("invalidMutations")
    void rejectsInvalidResults(String mutation) throws Exception {
        var n=fixture(); var s=(ObjectNode)n.get("segments").get(0); var c=(ObjectNode)n.get("coverage").get(0);
        switch(mutation) {
            case "unknown" -> n.put("secret","no");
            case "version" -> n.put("contractVersion","2.0");
            case "raw" -> n.put("resultType","RAW_ASR");
            case "failed" -> n.put("pipelineStatus","FAILED");
            case "source" -> n.put("sourceMediaId",UUID.randomUUID().toString());
            case "revision" -> n.put("sourceRevision","b".repeat(64));
            case "producer" -> n.put("producerStageRunId",UUID.randomUUID().toString());
            case "sampleRate" -> n.put("sampleRateHz",8000);
            case "sampleCount" -> n.put("sampleCount",230400001);
            case "duration" -> n.put("durationMs",1751);
            case "ordinal" -> s.put("ordinal",1);
            case "reverse" -> s.put("endMs",0);
            case "outOfBounds" -> s.put("endMs",1751);
            case "empty" -> n.putArray("segments");
            case "blank" -> s.put("text"," ");
            case "control" -> s.put("text","x\u0001");
            case "surrogate" -> s.put("text","x\ud800");
            case "longText" -> s.put("text","x".repeat(20001));
            case "coverage" -> n.putArray("coverage");
            case "quality" -> c.put("coverageStatus","UNRESOLVED_ERROR");
            case "recovery" -> c.put("recovered",true);
            case "warnings" -> n.put("pipelineStatus","COMPLETED_WITH_WARNINGS");
            case "provenance" -> ((ObjectNode)n.get("provenance")).put("endpoint","https://bad");
            case "model" -> ((ObjectNode)n.get("provenance").get("models").get(1)).put("requestedModel","https://bad");
            case "proof" -> ((ObjectNode)n.get("correctionProof")).put("outputSha256","b".repeat(64));
            case "coercion" -> n.put("sampleCount","28000");
            case "duplicateComponent" -> ((tools.jackson.databind.node.ArrayNode)n.get("provenance").get("components")).add(n.get("provenance").get("components").get(0));
            case "extraSegmentField" -> s.put("speakerLabel","invented");
            default -> throw new AssertionError();
        }
        assertThatThrownBy(()->validate(n)).isInstanceOf(WorkerException.class);
    }
    @Test void warningOnlyResultStaysWarningBearing() throws Exception {
        var n=fixture(); n.put("pipelineStatus","COMPLETED_WITH_WARNINGS");
        n.withArray("warnings").addObject().put("stage","CORRECTION").put("code","completed-with-warnings")
            .putNull("startSample").putNull("endSample").putNull("phase").putArray("sourceChunkIds");
        var result=validate(n);
        assertThat(result.status().name()).isEqualTo("READY_WITH_WARNINGS");
        assertThat(result.warningCount()).isEqualTo(1);
        assertThat(result.mapping(null,null).warningCount()).isEqualTo(1);
    }
}
