package com.sme.meetingassistant.api.meetingintelligence;

import static org.assertj.core.api.Assertions.*;

import com.sme.meetingassistant.api.meetingintelligence.internal.ActionItemAcceptanceRequest;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class ActionItemAcceptanceContractTests {
    static String request() {
        return """
            {"contractVersion":"1.0","eventId":"%s","stageRunId":"%s","claimToken":"%s",
             "source":{"snapshotId":"%s","transcriptId":"%s","contentRevision":3,"sha256":"%s"},
             "candidates":[{"candidateKey":"action-test","title":"Kiểm thử API đăng nhập",
                "details":null,"suggestedDueDate":"2026-11-15","evidenceSegmentIds":["%s"]}]}
            """.formatted(UUID.randomUUID(),UUID.randomUUID(),UUID.randomUUID(),UUID.randomUUID(),
                UUID.randomUUID(),"a".repeat(64),UUID.randomUUID());
    }
    @Test void exactBoundedContractAndEmptyBatchAreValid() {
        var root=WorkerJson.parse(request().getBytes(java.nio.charset.StandardCharsets.UTF_8),4194304);
        var parsed=ActionItemAcceptanceRequest.parse(root);
        assertThat(parsed.candidates()).hasSize(1);
        assertThat(parsed.candidates().getFirst().suggestedDueDate().toString()).isEqualTo("2026-11-15");
        ((tools.jackson.databind.node.ObjectNode)root).putArray("candidates");
        assertThat(ActionItemAcceptanceRequest.parse(root).candidates()).isEmpty();
    }
    @Test void duplicateKeysUnknownAuthorityAndUnsupportedDatesAreRejected() {
        String body=request();
        assertThatThrownBy(()->WorkerJson.parse(body.replace("\"contractVersion\":\"1.0\"",
            "\"contractVersion\":\"1.0\",\"contractVersion\":\"1.0\"").getBytes(),4194304)).isInstanceOf(RuntimeException.class);
        for(String invalid:new String[]{body.replace("2026-11-15","2026-02-31"),
            body.replace("2026-11-15","tomorrow"),body.replace("\"details\":null","\"details\":null,\"assigneeUserId\":null"),
            body.replace("\"contentRevision\":3","\"contentRevision\":3.0"),
            body.replace("\"contractVersion\":\"1.0\"","\"contractVersion\":\"2.0\""),
            body.replace("\"title\":\"Kiểm thử API đăng nhập\"","\"title\":\"bad\\ncontrol\""),
            body.replace("\"details\":null","\"details\":\"bad\\u202eformat\""),
            body.replace("\"eventId\":\"","\"eventId\":\"malformed-")}) {
            assertThatThrownBy(()->ActionItemAcceptanceRequest.parse(WorkerJson.parse(invalid.getBytes(java.nio.charset.StandardCharsets.UTF_8),4194304)))
                .isInstanceOf(RuntimeException.class);
        }
    }
    @Test void candidateAndEvidenceLimitsCannotBeBypassed() {
        var root=(tools.jackson.databind.node.ObjectNode)WorkerJson.MAPPER.readTree(request());
        var candidates=(tools.jackson.databind.node.ArrayNode)root.get("candidates");
        var original=candidates.get(0).deepCopy();
        candidates.add(original);
        assertThatThrownBy(()->ActionItemAcceptanceRequest.parse(root)).isInstanceOf(RuntimeException.class);
        candidates.removeAll();
        for(int i=0;i<201;i++) candidates.add(original.deepCopy());
        assertThatThrownBy(()->ActionItemAcceptanceRequest.parse(root)).isInstanceOf(RuntimeException.class);
    }
}
