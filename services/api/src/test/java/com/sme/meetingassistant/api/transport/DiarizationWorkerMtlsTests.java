package com.sme.meetingassistant.api.transport;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.media.diarization.*;
import com.sme.meetingassistant.api.media.service.ProcessingTranscriptEvidence.TimingSnapshot;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import java.net.URI;
import java.net.http.*;
import java.nio.file.Path;
import java.util.*;
import jakarta.servlet.DispatcherType;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;
import org.springframework.context.annotation.*;
import org.springframework.core.annotation.Order;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.context.support.AnnotationConfigWebApplicationContext;
import org.springframework.web.filter.DelegatingFilterProxy;
import org.springframework.web.servlet.DispatcherServlet;
import org.springframework.web.servlet.config.annotation.EnableWebMvc;

class DiarizationWorkerMtlsTests {
    @TempDir Path pki;
    @Test void allSixOperationsRequireWorkerPrincipalAndExactCapabilityOnPrivateMtls() throws Exception {
        TestPki.create(pki);var factory=new TomcatServletWebServerFactory(0);
        var connector=PrivateConnector.configure(factory,new PrivateConnector.Settings(true,"127.0.0.1",0,"localhost",
            pki.resolve("server.crt"),pki.resolve("server.key"),pki.resolve("ca.crt"),pki.resolve("ca.crt")));
        var app=new AnnotationConfigWebApplicationContext();
        var server=factory.getWebServer(context->{
            app.setServletContext(context);app.register(App.class);app.refresh();
            context.addServlet("dispatcher",new DispatcherServlet(app)).addMapping("/");
            context.addFilter("correlation",new com.sme.meetingassistant.api.observability.RequestObservabilityFilter(new com.sme.meetingassistant.api.config.RuntimeProperties()))
                .addMappingForUrlPatterns(EnumSet.of(DispatcherType.REQUEST),false,"/*");
            context.addFilter("security",new DelegatingFilterProxy("springSecurityFilterChain",app))
                .addMappingForUrlPatterns(EnumSet.of(DispatcherType.REQUEST),false,"/*");
        });server.start();
        String job=UUID.randomUUID().toString(),event=UUID.randomUUID().toString(),stage=UUID.randomUUID().toString();
        String path="/internal/v1/worker/processing-jobs/"+job+"/diarization/";
        var owner=WorkerJson.MAPPER.createObjectNode().put("contractVersion","1.0").put("eventId",event)
            .put("executionStageRunId",stage).put("claimToken",UUID.randomUUID().toString());
        var claim=WorkerJson.MAPPER.createObjectNode().put("contractVersion","1.0").put("eventId",event)
            .put("eventType","PROCESSING_DIARIZATION_REQUESTED").put("eventSchemaVersion",1)
            .put("meetingId",UUID.randomUUID().toString()).put("sourceMediaId",UUID.randomUUID().toString())
            .put("executionStageRunId",stage).put("claimRequestId",UUID.randomUUID().toString());
        var commands=Map.of("claim",claim,"snapshot",owner,"renew",owner,
            "complete",owner.deepCopy().put("commandId",UUID.randomUUID().toString()).put("resultSha256","a".repeat(64)).put("resultProducerStageRunId",stage),
            "fail",owner.deepCopy().put("commandId",UUID.randomUUID().toString()).put("phase","INFERENCE").put("category","TIMEOUT"));
        try(var worker=client("worker");var other=client("core");var mi=client("mi");var publicClient=HttpClient.newHttpClient()) {
            for(var command:commands.entrySet()) {
                var privateUri=URI.create("https://localhost:"+connector.getLocalPort()+path+command.getKey());
                assertThat(other.send(post(privateUri,command.getValue().toString()),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(403);
                assertThat(mi.send(post(privateUri,command.getValue().toString()),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(403);
                var publicUri=URI.create("http://localhost:"+server.getPort()+path+command.getKey());
                var denied=publicClient.send(post(publicUri,command.getValue().toString()),HttpResponse.BodyHandlers.ofString());
                assertThat(denied.statusCode()).isEqualTo(403);assertThat(denied.body()).doesNotContain("sourceRevision","transcriptId","objectKey");
            }
            var statusUri=URI.create("https://localhost:"+connector.getLocalPort()+path+"deliveries/"+event);
            assertThat(other.send(HttpRequest.newBuilder(statusUri).header("X-Request-Id","spk08").GET().build(),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(403);
            verifyNoInteractions(app.getBean(DiarizationWorkerService.class),app.getBean(DiarizationCompletion.class));
            for(var command:commands.entrySet()) {
                var response=worker.send(post(URI.create("https://localhost:"+connector.getLocalPort()+path+command.getKey()),command.getValue().toString()),HttpResponse.BodyHandlers.ofString());
                assertThat(response.statusCode()).isEqualTo(200);assertThat(response.headers().firstValue("Cache-Control")).hasValue("no-store");
                assertThat(WorkerJson.MAPPER.readTree(response.body()).path("meta").path("requestId").asText()).isEqualTo("spk08");
            }
            assertThat(worker.send(HttpRequest.newBuilder(statusUri).header("X-Request-Id","spk08").GET().build(),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(200);
            assertThat(worker.send(HttpRequest.newBuilder(URI.create("https://localhost:"+connector.getLocalPort()+path+"snapshot")).GET().build(),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(403);
            assertThat(worker.send(post(URI.create("https://localhost:"+connector.getLocalPort()+path+"claim"),claim.deepCopy().put("eventType","PROCESSING_JOB_QUEUED").toString()),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(422);
        } finally {server.stop();server.destroy();app.close();}
    }
    private HttpClient client(String name) {
        return HttpClient.newBuilder().sslContext(PemTls.clientContext(pki.resolve(name+".crt"),pki.resolve(name+".key"),
            pki.resolve("ca.crt"),pki.resolve("ca.crt"),"urn:sme:service:"+switch(name){case "worker"->"ai-worker";case "mi"->"mi-worker";default->"core-api";})).build();
    }
    private HttpRequest post(URI uri,String body) {
        return HttpRequest.newBuilder(uri).header("X-Request-Id","spk08").header("X-Service-Identity","urn:sme:service:ai-worker")
            .header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(body)).build();
    }
    @Configuration(proxyBeanMethods=false) @EnableWebMvc @EnableWebSecurity @Import(SecureTransportConfiguration.class)
    static class App {
        @Bean DiarizationWorkerService worker() {
            var w=mock(DiarizationWorkerService.class);var data=Map.<String,Object>of("contractVersion","1.0","state","RESULT_VERIFIED","acknowledge",false);
            when(w.claim(any(),any())).thenReturn(data);when(w.renew(any(),any())).thenReturn(data);when(w.status(any(),any())).thenReturn(data);when(w.fail(any(),any())).thenReturn(data);
            when(w.snapshot(any(),any())).thenReturn(new TimingSnapshot(UUID.randomUUID(),0,1000,List.of()));return w;
        }
        @Bean DiarizationCompletion completion() {var c=mock(DiarizationCompletion.class);when(c.complete(any(),any())).thenReturn(Map.of("state","RESULT_VERIFIED","acknowledge",false));return c;}
        @Bean DiarizationWorkerController controller(DiarizationWorkerService w,DiarizationCompletion c) {return new DiarizationWorkerController(w,c,new ApiResponseFactory());}
        @Bean @Order(100) SecurityFilterChain other(HttpSecurity http) throws Exception {return http.authorizeHttpRequests(a->a.anyRequest().permitAll()).build();}
    }
}
