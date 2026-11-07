package com.sme.meetingassistant.api.media.diarization;

import static org.assertj.core.api.Assertions.*;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class DiarizationCommandsTests {
    @Test void claimRequiresExplicitIntegerEventVersion() {
        var n=claimPayload();
        assertThat(DiarizationCommands.claim(n).eventSchemaVersion()).isEqualTo(1);
        assertThatThrownBy(()->DiarizationCommands.claim(n.deepCopy().put("contractVersion","1")))
            .isInstanceOf(WorkerException.class);
    }

    @ParameterizedTest
    @ValueSource(strings={"missing","null","\"1\"","true","false","1.0","1.5","0","-1","2","[]","{}","999999999999999999999"})
    void claimRejectsMissingMalformedAndUnsupportedVersionsWithoutCoercion(String version) {
        var n=claimPayload();
        if("missing".equals(version)) n.remove("eventSchemaVersion");
        else n.set("eventSchemaVersion",WorkerJson.MAPPER.readTree(version));
        assertThatThrownBy(()->DiarizationCommands.claim(n)).isInstanceOfSatisfying(WorkerException.class,e->{
            assertThat(e.status()).isEqualTo(422);
            assertThat(e.code()).isEqualTo("VALIDATION_ERROR");
            assertThat(e.getMessage()).isEqualTo("VALIDATION_ERROR");
        });
    }

    private tools.jackson.databind.node.ObjectNode claimPayload() {
        return WorkerJson.MAPPER.createObjectNode().put("contractVersion","1.0")
            .put("eventId",UUID.randomUUID().toString()).put("eventType","PROCESSING_DIARIZATION_REQUESTED")
            .put("eventSchemaVersion",1).put("meetingId",UUID.randomUUID().toString())
            .put("sourceMediaId",UUID.randomUUID().toString()).put("executionStageRunId",UUID.randomUUID().toString())
            .put("claimRequestId",UUID.randomUUID().toString());
    }

    @Test void rejectsUnknownFieldsRawResultsAndWorkerRetryPolicy() {
        var owner=WorkerJson.MAPPER.createObjectNode().put("contractVersion","1.0")
            .put("eventId",UUID.randomUUID().toString()).put("executionStageRunId",UUID.randomUUID().toString())
            .put("claimToken",UUID.randomUUID().toString());
        var complete=owner.deepCopy().put("commandId",UUID.randomUUID().toString())
            .put("resultSha256","a".repeat(64)).put("resultProducerStageRunId",UUID.randomUUID().toString());
        assertThat(DiarizationCommands.complete(complete).resultSha256()).isEqualTo("a".repeat(64));
        assertThatThrownBy(()->DiarizationCommands.complete(complete.deepCopy().put("resultSha256","A".repeat(64))))
            .isInstanceOf(WorkerException.class);
        assertThatThrownBy(()->DiarizationCommands.complete(complete.deepCopy().putObject("result")))
            .isInstanceOf(WorkerException.class);
        var fail=owner.deepCopy().put("commandId",UUID.randomUUID().toString()).put("phase","INFERENCE").put("category","TIMEOUT");
        assertThat(DiarizationCommands.fail(fail).retryable()).isTrue();
        assertThatThrownBy(()->DiarizationCommands.fail(fail.deepCopy().put("retryable",true))).isInstanceOf(WorkerException.class);
        assertThatThrownBy(()->DiarizationCommands.fail(fail.deepCopy().put("category","provider secret text"))).isInstanceOf(WorkerException.class);
        assertThat(DiarizationCommands.owner(owner).toString()).doesNotContain(owner.path("claimToken").asText());
    }
}
