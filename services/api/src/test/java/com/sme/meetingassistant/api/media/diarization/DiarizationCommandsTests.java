package com.sme.meetingassistant.api.media.diarization;

import static org.assertj.core.api.Assertions.*;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class DiarizationCommandsTests {
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
