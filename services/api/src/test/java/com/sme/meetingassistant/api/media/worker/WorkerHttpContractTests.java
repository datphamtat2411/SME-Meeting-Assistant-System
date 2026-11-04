package com.sme.meetingassistant.api.media.worker;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.integration.TranscriptionWorkerCompletion;
import com.sme.meetingassistant.api.media.MediaProperties;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

/** MVC wire tests; authentication is exercised by real-TLS transport tests separately. */
class WorkerHttpContractTests {
    TranscriptionWorkerService worker; TranscriptionWorkerCompletion completion; MockMvc mvc;
    String job=UUID.randomUUID().toString(),event=UUID.randomUUID().toString();
    String base="/internal/v1/worker/processing-jobs/"+job+"/transcription/";
    String claim;
    @BeforeEach void setUp() {
        worker=mock(TranscriptionWorkerService.class);completion=mock(TranscriptionWorkerCompletion.class);
        mvc=MockMvcBuilders.standaloneSetup(new TranscriptionWorkerController(worker,completion,new ApiResponseFactory()))
            .addFilters(new com.sme.meetingassistant.api.observability.RequestObservabilityFilter(new com.sme.meetingassistant.api.config.RuntimeProperties())).build();
        claim="{\"contractVersion\":\"1.0\",\"eventId\":\""+event+"\",\"eventType\":\"PROCESSING_JOB_QUEUED\",\"eventSchemaVersion\":1,\"meetingId\":\""+UUID.randomUUID()+"\",\"sourceMediaId\":\""+UUID.randomUUID()+"\",\"requestedByUserId\":\""+UUID.randomUUID()+"\",\"generation\":0,\"claimRequestId\":\""+UUID.randomUUID()+"\"}";
    }
    @Test void allFiveOperationsUseCommonEnvelopeAndNoStore() throws Exception {
        var status=Map.<String,Object>of("contractVersion","1.0","state","AVAILABLE");
        when(worker.claim(any(),any())).thenReturn(Map.of("claimToken",UUID.randomUUID()));
        when(worker.status(any(),any())).thenReturn(status); when(worker.renew(any(),any())).thenReturn(status);
        when(worker.fail(any(),any())).thenReturn(status); when(completion.complete(any(),any())).thenReturn(status);
        mvc.perform(post(base+"claim").contentType("application/json").header("X-Request-Id","worker-test").content(claim))
            .andExpect(status().isOk()).andExpect(jsonPath("$.code").value("WORKER_CLAIMED")).andExpect(header().string("Cache-Control","no-store"));
        var owner=WorkerJson.MAPPER.createObjectNode().put("contractVersion","1.0").put("eventId",event).put("generation",0)
            .put("executionStageRunId",UUID.randomUUID().toString()).put("claimToken",UUID.randomUUID().toString());
        mvc.perform(post(base+"renew").contentType("application/json").header("X-Request-Id","worker-test").content(owner.toString())).andExpect(status().isOk());
        var complete=owner.deepCopy().put("commandId",UUID.randomUUID().toString()).put("resultSha256","a".repeat(64)).put("resultProducerStageRunId",UUID.randomUUID().toString());
        mvc.perform(post(base+"complete").contentType("application/json").header("X-Request-Id","worker-test").content(complete.toString())).andExpect(status().isOk());
        var fail=owner.deepCopy().put("commandId",UUID.randomUUID().toString()).put("phase","ASR").put("category","PROVIDER").putNull("completedThrough"); fail.putObject("metrics");
        mvc.perform(post(base+"fail").contentType("application/json").header("X-Request-Id","worker-test").content(fail.toString())).andExpect(status().isOk());
        mvc.perform(get(base+"deliveries/"+event).header("X-Request-Id","worker-test")).andExpect(status().isOk())
            .andExpect(jsonPath("$.success").value(true)).andExpect(jsonPath("$.meta.requestId").exists()).andExpect(header().string("Cache-Control","no-store"));
    }
    @Test void rejectsStrictWireViolationsBeforeBusinessCode() throws Exception {
        for(String body:new String[]{claim.replace("\"1.0\"","\"2.0\""),claim.replace("\"generation\":0","\"generation\":true"),
            claim.replace("\"generation\":0","\"generation\":\"0\""),claim.replace("\"generation\":0","\"generation\":0.0"),
            claim.replace("\"generation\":0","\"generation\":0,\"extra\":0"),claim.replace("\"generation\":0","\"generation\":0,\"generation\":0"),
            claim.replace(event,"1-1-1-1-1")}) {
            mvc.perform(post(base+"claim").contentType("application/json").header("X-Request-Id","worker-test").content(body))
                .andExpect(status().isUnprocessableEntity()).andExpect(jsonPath("$.success").value(false)).andExpect(header().string("Cache-Control","no-store"));
        }
        mvc.perform(post(base+"claim").contentType("application/json").header("X-Request-Id","worker-test").content(claim.replace("1.0","2.0")))
            .andExpect(jsonPath("$.code").value("WORKER_CONTRACT_UNSUPPORTED"));
        mvc.perform(post(base+"claim").contentType("application/json").header("X-Request-Id","worker-test").content(" ".repeat(16385)))
            .andExpect(status().is(413));
        mvc.perform(post(base+"claim").contentType("text/plain").header("X-Request-Id","worker-test").content(claim)).andExpect(status().isUnsupportedMediaType());
        verifyNoInteractions(worker,completion);
    }
    @Test void disabledAndIncompleteConfigurationFailClosed() {
        var env=new MockEnvironment();
        var capability=new TranscriptionWorkerCapability(env,new MediaProperties());
        assertThatThrownBy(capability::requireAvailable).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        env.setProperty("app.worker.transcription.enabled","true");
        assertThatThrownBy(()->new TranscriptionWorkerCapability(env,new MediaProperties())).isInstanceOf(IllegalStateException.class);
    }
    @Test void failureClassificationIsCoreOwnedAndOrdered() {
        var owner=new WorkerCommands.Owner(UUID.randomUUID(),0,UUID.randomUUID(),UUID.randomUUID());
        assertThat(WorkerFailure.classify(new WorkerCommands.Fail(UUID.randomUUID(),owner,"CORRECTION","AUTHENTICATION",null,Map.of()),"TRANSCRIPTION").code())
            .isEqualTo("WORKER_CONFIGURATION_INVALID");
        assertThat(WorkerFailure.classify(new WorkerCommands.Fail(UUID.randomUUID(),owner,"CORRECTION","PROVIDER",null,Map.of()),"TRANSCRIPTION").retryable()).isTrue();
        assertThatThrownBy(()->WorkerFailure.classify(new WorkerCommands.Fail(UUID.randomUUID(),owner,"ASR","DECODING",null,Map.of()),"TRANSCRIPTION"))
            .isInstanceOf(WorkerException.class);
    }
}
