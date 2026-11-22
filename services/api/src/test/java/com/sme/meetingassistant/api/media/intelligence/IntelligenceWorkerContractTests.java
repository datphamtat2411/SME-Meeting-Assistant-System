package com.sme.meetingassistant.api.media.intelligence;

import static org.assertj.core.api.Assertions.*;
import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import com.sme.meetingassistant.api.transport.WorkerOperations;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

class IntelligenceWorkerContractTests {
    @Test void strictCommandsRejectUnknownFieldsWrongTypesAndUnsupportedVersions() {
        var n=WorkerJson.MAPPER.createObjectNode().put("contractVersion","1.0").put("eventId",UUID.randomUUID().toString())
            .put("eventType","PROCESSING_INTELLIGENCE_STAGE_REQUESTED").put("eventSchemaVersion",1)
            .put("executionStageRunId",UUID.randomUUID().toString()).put("executionStageCode","GENERATING_SUMMARY")
            .put("claimRequestId",UUID.randomUUID().toString());
        assertThat(IntelligenceCommands.claim(n).executionStageCode()).isEqualTo("GENERATING_SUMMARY");
        assertThatThrownBy(()->IntelligenceCommands.claim(n.deepCopy().put("eventSchemaVersion","1"))).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(()->IntelligenceCommands.claim(n.deepCopy().put("eventSchemaVersion",2))).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(()->IntelligenceCommands.claim(n.deepCopy().put("contractVersion","2.0"))).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(()->IntelligenceCommands.claim(n.deepCopy().put("objectKey","arbitrary"))).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(()->IntelligenceCommands.claim(n.deepCopy().put("executionStageCode","TRANSCRIPTION"))).isInstanceOf(RuntimeException.class);
    }
    @Test void newGrantsAreExclusiveToMeetingIntelligenceMachineIdentity() {
        String base="/internal/v1/worker/processing-jobs/"+UUID.randomUUID()+"/intelligence/";
        for(String operation:new String[]{"claim","renew","fail"}) {
            String grant=WorkerOperations.operation("POST",base+operation);
            assertThat(grant).isEqualTo("intelligence."+operation);
            assertThat(WorkerOperations.allowed("urn:sme:service:mi-worker",grant)).isTrue();
            assertThat(WorkerOperations.allowed("urn:sme:service:ai-worker",grant)).isFalse();
        }
        assertThat(WorkerOperations.operation("POST",base+"complete")).isNull();
        assertThat(WorkerOperations.operation("POST",base+"attempts/reserve"))
            .isEqualTo("intelligence.attempts-reserve");
        assertThat(WorkerOperations.operation("POST",base+"attempts/report"))
            .isEqualTo("intelligence.attempts-report");
        assertThat(WorkerOperations.allowed("urn:sme:service:mi-worker",
            "intelligence.attempts-reserve")).isTrue();
        assertThat(WorkerOperations.allowed("urn:sme:service:ai-worker",
            "intelligence.attempts-report")).isFalse();
        assertThat(WorkerOperations.operation("GET",base+"deliveries/"+UUID.randomUUID())).isEqualTo("intelligence.read-delivery");
    }
    @Test void capabilityAndDispatchDefaultOffAndInvalidEnablementFailsClosed() {
        var properties=new MediaProperties();var env=new MockEnvironment();
        var capability=new IntelligenceWorkerCapability(env,properties);
        assertThat(capability.canDispatch("GENERATING_SUMMARY")).isFalse();
        assertThatThrownBy(()->capability.requireStage("GENERATING_SUMMARY")).isInstanceOf(RuntimeException.class);
        properties.getIntelligence().setEnabled(true);
        assertThatThrownBy(()->new IntelligenceWorkerCapability(env,properties)).isInstanceOf(IllegalStateException.class);
    }
    @Test void providerAttemptReportRequiresAnOutcomeCompatibleFailureCategory() {
        var event=UUID.randomUUID();var stage=UUID.randomUUID();var claim=UUID.randomUUID();var attempt=UUID.randomUUID();
        var success=WorkerJson.MAPPER.createObjectNode()
            .put("contractVersion","1.0").put("eventId",event.toString())
            .put("executionStageRunId",stage.toString()).put("claimToken",claim.toString())
            .put("attemptId",attempt.toString()).put("executionStageCode","GENERATING_SUMMARY")
            .put("outcome","SUCCEEDED").put("inputTokens",7431).put("outputTokens",32768)
            .put("totalTokens",40199).putNull("reasoningTokens").put("reportedCostUsd","0.0342542")
            .putNull("failureCategory");
        assertThat(IntelligenceCommands.attemptReport(success).outcome()).isEqualTo("SUCCEEDED");
        assertThatThrownBy(() -> IntelligenceCommands.attemptReport(
            success.deepCopy().put("failureCategory","PROVIDER")))
            .isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> IntelligenceCommands.attemptReport(
            success.deepCopy().put("outcome","FAILED").putNull("failureCategory")))
            .isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> IntelligenceCommands.attemptReport(
            success.deepCopy().putNull("outputTokens")))
            .isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> IntelligenceCommands.attemptReport(
            success.deepCopy().put("totalTokens",40198)))
            .isInstanceOf(RuntimeException.class);
    }
    @Test void provisionerCreatesDedicatedRouteWithoutWideningExistingWorkerCredentials() throws Exception {
        var process=new ProcessBuilder("python3","-c","""
            import importlib.util,json
            spec=importlib.util.spec_from_file_location('broker','../../infra/local/secure-integration/broker.py')
            b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
            d=b.definitions('test',{'publisher':'p','worker':'w','reconciler':'r','intelligence':'i'},intelligence=True)
            assert any(q['name']=='meeting.processing.intelligence' and q['durable'] for q in d['queues'])
            assert any(x['destination']=='meeting.processing.intelligence' and x['routing_key']=='processing.intelligence.requested' for x in d['bindings'])
            assert next(p for p in d['permissions'] if p['user']=='w')['read']==r'^meeting\\.processing\\.jobs$'
            assert next(p for p in d['permissions'] if p['user']=='i')['read']==r'^meeting\\.processing\\.intelligence$'
            """).redirectErrorStream(true).start();
        String output=new String(process.getInputStream().readAllBytes(),java.nio.charset.StandardCharsets.UTF_8);
        assertThat(process.waitFor()).withFailMessage(output).isZero();
    }
}
