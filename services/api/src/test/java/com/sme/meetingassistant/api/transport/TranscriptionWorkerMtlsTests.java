package com.sme.meetingassistant.api.transport;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.integration.TranscriptionWorkerCompletion;
import com.sme.meetingassistant.api.media.worker.*;
import java.net.URI;
import java.net.http.*;
import java.nio.file.Path;
import java.util.EnumSet;
import java.util.Map;
import java.util.UUID;
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

/** Real Tomcat + production E2E-01 chain + actual five-operation MVC adapter; isolated business port. */
class TranscriptionWorkerMtlsTests {
    @TempDir Path pki;
    @Test void fiveBusinessRoutesRequirePrivateVerifiedTransport() throws Exception {
        TestPki.create(pki);
        var factory=new TomcatServletWebServerFactory(0);
        var connector=PrivateConnector.configure(factory,new PrivateConnector.Settings(true,"127.0.0.1",0,"localhost",
            pki.resolve("server.crt"),pki.resolve("server.key"),pki.resolve("ca.crt"),pki.resolve("ca.crt")));
        var app=new AnnotationConfigWebApplicationContext();
        var server=factory.getWebServer(context->{
            app.setServletContext(context);app.register(App.class);app.refresh();
            context.addServlet("dispatcher",new DispatcherServlet(app)).addMapping("/");
            context.addFilter("requestCorrelation",new com.sme.meetingassistant.api.observability.RequestObservabilityFilter(
                new com.sme.meetingassistant.api.config.RuntimeProperties())).addMappingForUrlPatterns(EnumSet.of(DispatcherType.REQUEST),false,"/*");
            context.addFilter("springSecurity",new DelegatingFilterProxy("springSecurityFilterChain",app))
                .addMappingForUrlPatterns(EnumSet.of(DispatcherType.REQUEST),false,"/*");
        });
        server.start();
        String job=UUID.randomUUID().toString(),event=UUID.randomUUID().toString();
        String path="/internal/v1/worker/processing-jobs/"+job+"/transcription/";
        var owner=WorkerJson.MAPPER.createObjectNode().put("contractVersion","1.0").put("eventId",event).put("generation",0)
            .put("executionStageRunId",UUID.randomUUID().toString()).put("claimToken",UUID.randomUUID().toString());
        var claim=WorkerJson.MAPPER.createObjectNode().put("contractVersion","1.0").put("eventId",event).put("generation",0)
            .put("eventType","PROCESSING_JOB_QUEUED").put("eventSchemaVersion",1).put("meetingId",UUID.randomUUID().toString())
            .put("sourceMediaId",UUID.randomUUID().toString()).put("requestedByUserId",UUID.randomUUID().toString()).put("claimRequestId",UUID.randomUUID().toString());
        var complete=owner.deepCopy().put("commandId",UUID.randomUUID().toString()).put("resultSha256","a".repeat(64)).put("resultProducerStageRunId",UUID.randomUUID().toString());
        var fail=owner.deepCopy().put("commandId",UUID.randomUUID().toString()).put("phase","ASR").put("category","PROVIDER").putNull("completedThrough");fail.putObject("metrics");
        try(var client=HttpClient.newBuilder().sslContext(PemTls.clientContext(pki.resolve("worker.crt"),pki.resolve("worker.key"),
                pki.resolve("ca.crt"),pki.resolve("ca.crt"),"urn:sme:service:ai-worker")).build();var publicClient=HttpClient.newHttpClient()) {
            for(var operation:Map.of("claim",claim,"renew",owner,"complete",complete,"fail",fail).entrySet()) {
                var response=client.send(HttpRequest.newBuilder(URI.create("https://localhost:"+connector.getLocalPort()+path+operation.getKey()))
                    .header("Content-Type","application/json").header("X-Request-Id","mtls-worker-test")
                    .POST(HttpRequest.BodyPublishers.ofString(operation.getValue().toString())).build(),HttpResponse.BodyHandlers.ofString());
                assertThat(response.statusCode()).isEqualTo(200);assertThat(response.headers().firstValue("Cache-Control")).hasValue("no-store");
                assertThat(response.headers().firstValue("X-Request-Id")).hasValue("mtls-worker-test");
                assertThat(WorkerJson.MAPPER.readTree(response.body()).get("meta").get("requestId").asString()).isEqualTo("mtls-worker-test");
            }
            assertThat(client.send(HttpRequest.newBuilder(URI.create("https://localhost:"+connector.getLocalPort()+path+"deliveries/"+event))
                .header("X-Request-Id","mtls-worker-test").GET().build(),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(200);
            assertThat(publicClient.send(HttpRequest.newBuilder(URI.create("http://localhost:"+server.getPort()+path+"claim"))
                .header("X-Service-Identity","urn:sme:service:ai-worker").POST(HttpRequest.BodyPublishers.ofString(claim.toString())).build(),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(403);
        } finally {server.stop();server.destroy();app.close();}
    }
    @Configuration(proxyBeanMethods=false) @EnableWebMvc @EnableWebSecurity
    @Import(SecureTransportConfiguration.class)
    static class App {
        @Bean TranscriptionWorkerController controller() {
            var worker=mock(TranscriptionWorkerService.class);var completion=mock(TranscriptionWorkerCompletion.class);
            var data=Map.<String,Object>of("contractVersion","1.0","state","AVAILABLE");
            when(worker.claim(any(),any())).thenReturn(data);when(worker.renew(any(),any())).thenReturn(data);
            when(worker.status(any(),any())).thenReturn(data);when(worker.fail(any(),any())).thenReturn(data);when(completion.complete(any(),any())).thenReturn(data);
            return new TranscriptionWorkerController(worker,completion,new ApiResponseFactory());
        }
        @Bean @Order(100) SecurityFilterChain otherRoutes(HttpSecurity http) throws Exception {
            return http.authorizeHttpRequests(a->a.anyRequest().permitAll()).build();
        }
    }
}
