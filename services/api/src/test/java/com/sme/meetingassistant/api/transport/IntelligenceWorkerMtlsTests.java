package com.sme.meetingassistant.api.transport;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.media.intelligence.*;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import jakarta.servlet.DispatcherType;
import java.net.URI;
import java.net.http.*;
import java.nio.file.Path;
import java.util.*;
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

class IntelligenceWorkerMtlsTests {
    @TempDir Path pki;
    @Test void explicitInfrastructureConfigurationEnablesOnlyDeclaredStagesAndSupportsDispatchPause() throws Exception {
        TestPki.create(pki);
        var p=new com.sme.meetingassistant.api.media.MediaProperties();var i=p.getIntelligence();var s=p.getStorage();
        i.setEnabled(true);i.setDispatchEnabled(true);i.setInfrastructureVerified(true);i.setStorageId("meeting-media");
        i.setEnabledStages(List.of("GENERATING_SUMMARY"));
        s.setEndpoint("https://storage.internal:9443");s.setBucket("meeting-media");s.setRegion("us-east-1");s.setCaFile(pki.resolve("ca.crt").toString());
        p.getOutbox().setExchange("meeting.processing");p.getOutbox().setRoutingKey("processing.job.queued");
        var env=new org.springframework.mock.env.MockEnvironment().withProperty("app.transport.private.enabled","true")
            .withProperty("app.mi.internal-result.enabled","true").withProperty("spring.rabbitmq.ssl.enabled","true")
            .withProperty("spring.rabbitmq.ssl.validate-server-certificate","true").withProperty("spring.rabbitmq.ssl.verify-hostname","true")
            .withProperty("spring.rabbitmq.publisher-confirm-type","correlated").withProperty("spring.rabbitmq.publisher-returns","true")
            .withProperty("spring.rabbitmq.template.mandatory","true").withProperty("app.media.messaging.topology","external-quorum");
        var capability=new IntelligenceWorkerCapability(env,p);
        assertThat(capability.canDispatch("GENERATING_SUMMARY")).isTrue();assertThat(capability.canDispatch("EXTRACTING_DECISIONS")).isFalse();
        i.setDispatchEnabled(false);assertThat(new IntelligenceWorkerCapability(env,p).canDispatch("GENERATING_SUMMARY")).isFalse();
        assertThatCode(()->capability.requireStage("GENERATING_SUMMARY")).doesNotThrowAnyException();
        p.getOutbox().setIntelligenceRoutingKey("processing.job.queued");
        assertThatThrownBy(()->new IntelligenceWorkerCapability(env,p)).isInstanceOf(IllegalStateException.class);
    }
    @Test void fourOperationsRequirePrivateMiIdentityAndNeverTrustPublicJwtOrIdentityHeaders() throws Exception {
        TestPki.create(pki);var factory=new TomcatServletWebServerFactory(0);
        var connector=PrivateConnector.configure(factory,new PrivateConnector.Settings(true,"127.0.0.1",0,"localhost",
            pki.resolve("server.crt"),pki.resolve("server.key"),pki.resolve("ca.crt"),pki.resolve("ca.crt")));
        var app=new AnnotationConfigWebApplicationContext();
        var server=factory.getWebServer(context->{
            app.setServletContext(context);app.register(App.class);app.refresh();
            context.addServlet("dispatcher",new DispatcherServlet(app)).addMapping("/");
            context.addFilter("security",new DelegatingFilterProxy("springSecurityFilterChain",app))
                .addMappingForUrlPatterns(EnumSet.of(DispatcherType.REQUEST),false,"/*");
        });server.start();
        String path="/internal/v1/worker/processing-jobs/"+UUID.randomUUID()+"/intelligence/";
        String event=UUID.randomUUID().toString(),stage=UUID.randomUUID().toString();
        var claim=WorkerJson.MAPPER.createObjectNode().put("contractVersion","1.0").put("eventId",event)
            .put("eventType","PROCESSING_INTELLIGENCE_STAGE_REQUESTED").put("eventSchemaVersion",1)
            .put("executionStageRunId",stage).put("executionStageCode","GENERATING_SUMMARY").put("claimRequestId",UUID.randomUUID().toString());
        var owner=WorkerJson.MAPPER.createObjectNode().put("contractVersion","1.0").put("eventId",event)
            .put("executionStageRunId",stage).put("claimToken",UUID.randomUUID().toString());
        var commands=Map.of("claim",claim,"renew",owner,"fail",owner.deepCopy()
            .put("commandId",UUID.randomUUID().toString()).put("phase","INFERENCE").put("category","TIMEOUT"));
        try(var mi=client("mi","mi-worker");var worker=client("worker","ai-worker");var core=client("core","core-api");var plain=HttpClient.newHttpClient()) {
            for(var command:commands.entrySet()) {
                URI uri=URI.create("https://localhost:"+connector.getLocalPort()+path+command.getKey());
                assertThat(worker.send(post(uri,command.getValue().toString()),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(403);
                assertThat(core.send(post(uri,command.getValue().toString()),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(403);
                var publicUri=URI.create("http://localhost:"+server.getPort()+path+command.getKey());
                assertThat(plain.send(post(publicUri,command.getValue().toString()),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(403);
            }
            verifyNoInteractions(app.getBean(IntelligenceWorkerService.class));
            for(var command:commands.entrySet()) {
                var response=mi.send(post(URI.create("https://localhost:"+connector.getLocalPort()+path+command.getKey()),command.getValue().toString()),HttpResponse.BodyHandlers.ofString());
                assertThat(response.statusCode()).isEqualTo(200);assertThat(response.headers().firstValue("Cache-Control")).hasValue("no-store");
            }
            URI status=URI.create("https://localhost:"+connector.getLocalPort()+path+"deliveries/"+event);
            assertThat(mi.send(HttpRequest.newBuilder(status).header("X-Request-Id","aimi").GET().build(),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(200);
            assertThat(worker.send(HttpRequest.newBuilder(status).header("X-Request-Id","aimi").GET().build(),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(403);
            assertThat(mi.send(post(URI.create("https://localhost:"+connector.getLocalPort()+path+"claim"),claim.deepCopy().put("claimToken","leak").toString()),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(422);
            assertThat(mi.send(post(URI.create("https://localhost:"+connector.getLocalPort()+path+"complete"),owner.toString()),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(403);
            assertThat(mi.send(post(URI.create("https://localhost:"+connector.getLocalPort()+path+"claim")," ".repeat(17000)),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(413);
            verify(app.getBean(IntelligenceWorkerService.class)).claim(any(),any(),matches("[a-f0-9]{64}"));
        } finally {server.stop();server.destroy();app.close();}
    }
    HttpClient client(String name,String principal) {return HttpClient.newBuilder().sslContext(PemTls.clientContext(pki.resolve(name+".crt"),pki.resolve(name+".key"),pki.resolve("ca.crt"),pki.resolve("ca.crt"),"urn:sme:service:"+principal)).build();}
    HttpRequest post(URI uri,String body) {return HttpRequest.newBuilder(uri).header("Content-Type","application/json").header("X-Request-Id","aimi")
        .header("X-Service-Identity","urn:sme:service:mi-worker").header("Authorization","Bearer ordinary-user-jwt")
        .POST(HttpRequest.BodyPublishers.ofString(body)).build();}
    @Configuration(proxyBeanMethods=false) @EnableWebMvc @EnableWebSecurity @Import(SecureTransportConfiguration.class)
    static class App {
        @Bean IntelligenceWorkerService worker() {
            var w=mock(IntelligenceWorkerService.class);var data=Map.<String,Object>of("contractVersion","1.0","state","AVAILABLE","acknowledge",false);
            when(w.claim(any(),any(),anyString())).thenReturn(data);when(w.renew(any(),any(),anyString())).thenReturn(data);
            when(w.fail(any(),any(),anyString())).thenReturn(data);when(w.status(any(),any())).thenReturn(data);return w;
        }
        @Bean IntelligenceWorkerController controller(IntelligenceWorkerService w) {return new IntelligenceWorkerController(w,new ApiResponseFactory());}
        @Bean @Order(100) SecurityFilterChain other(HttpSecurity http) throws Exception {return http.authorizeHttpRequests(a->a.anyRequest().permitAll()).build();}
    }
}
