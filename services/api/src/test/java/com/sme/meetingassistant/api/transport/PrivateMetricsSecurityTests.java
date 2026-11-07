package com.sme.meetingassistant.api.transport;

import static org.assertj.core.api.Assertions.*;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.net.*;
import java.net.http.*;
import java.nio.file.*;
import java.util.*;
import javax.net.ssl.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.micrometer.metrics.test.autoconfigure.AutoConfigureMetrics;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.annotation.Import;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.*;

/** Full application security chains and real public/private Tomcat sockets; no auth mocks. */
@ActiveProfiles("test")
@AutoConfigureMetrics(export=true)
@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,properties={
    "app.monitoring.private.enabled=true","app.transport.private.enabled=true",
    "app.transport.private.hostname=localhost","app.media.outbox.enabled=false"})
@Import(PostgresTestConfiguration.class)
@DirtiesContext
class PrivateMetricsSecurityTests {
    static Path pki;
    static int port;
    static final String PATH="/internal/monitoring/prometheus";
    @Autowired WebServerApplicationContext context;
    @Autowired io.micrometer.prometheusmetrics.PrometheusMeterRegistry registry;

    @DynamicPropertySource static void tls(DynamicPropertyRegistry r) throws Exception {
        pki=Files.createTempDirectory("spk12-pki-");TestPki.create(pki);
        TestPki.issue(pki,"monitor","URI:urn:sme:service:monitoring","clientAuth","ca",false);
        TestPki.issue(pki,"ambiguous-monitor","URI:urn:sme:service:monitoring,URI:urn:sme:service:ai-worker","clientAuth","ca",false);
        TestPki.issue(pki,"malformed-monitor","URI:urn:sme:service:MONITORING","clientAuth","ca",false);
        try(var socket=new ServerSocket(0)) {port=socket.getLocalPort();}
        r.add("app.transport.private.port",()->port);
        r.add("app.transport.private.certificate",()->pki.resolve("server.crt").toString());
        r.add("app.transport.private.key",()->pki.resolve("server.key").toString());
        r.add("app.transport.private.issuer-ca",()->pki.resolve("ca.crt").toString());
        r.add("app.transport.private.client-ca",()->pki.resolve("ca.crt").toString());
    }
    @AfterAll static void cleanup() throws Exception {
        if(pki!=null) try(var paths=Files.walk(pki)) {for(var path:paths.sorted(Comparator.reverseOrder()).toList()) Files.delete(path);}
    }
    private HttpClient client(String name) {
        return HttpClient.newBuilder().sslContext(PemTls.clientContext(pki.resolve(name+".crt"),pki.resolve(name+".key"),
            pki.resolve("ca.crt"),pki.resolve("ca.crt"),"urn:sme:service:"+switch(name){case "monitor"->"monitoring";case "worker"->"ai-worker";default->"core-api";})).build();
    }
    private HttpResponse<String> get(HttpClient client,String base,String path) throws Exception {
        return client.send(HttpRequest.newBuilder(URI.create(base+path)).header("X-Service-Identity","urn:sme:service:monitoring")
            .header("X-Forwarded-Proto","https").GET().build(),HttpResponse.BodyHandlers.ofString());
    }
    private String privateBase() {return "https://localhost:"+port;}
    @Test void publicConnectorCannotScrapeEvenWithIdentityOrForwardedHeaders() throws Exception {
        try(var client=client("monitor")) {
            for(var path:List.of(PATH,PATH+";x=y","/actuator/prometheus","/actuator/metrics","/actuator/metrics/diarization.window.outcomes")) {
                var response=get(client,"http://localhost:"+context.getWebServer().getPort(),path);
                assertThat(response.statusCode()).isEqualTo(403);sanitized(response.body());
            }
            assertThat(get(client,"http://localhost:"+context.getWebServer().getPort(),"/actuator/health/liveness").statusCode()).isEqualTo(200);
        }
    }
    @Test void unauthorizedCertificateIdentityIsRejected() throws Exception {
        for(String name:List.of("worker","core")) try(var client=client(name)) {
            var response=get(client,privateBase(),PATH);assertThat(response.statusCode()).isEqualTo(403);sanitized(response.body());
        }
        for(String name:List.of("ambiguous-monitor","malformed-monitor","missing-uri")) {
            // Present the actual invalid leaf to Tomcat; the production client helper correctly
            // refuses invalid local identities before sending, so use its keystore primitives.
            var chain=PemTls.certificates(pki.resolve(name+".crt"));
            var keys=java.security.KeyStore.getInstance("PKCS12");keys.load(null,null);
            keys.setKeyEntry("workload",PemTls.privateKey(pki.resolve(name+".key"),chain.getFirst().getPublicKey().getAlgorithm()),
                new char[0],chain.toArray(java.security.cert.Certificate[]::new));
            var km=KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
            km.init(keys,new char[0]);
            var tm=TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());tm.init(PemTls.trustStore(pki.resolve("ca.crt")));
            var ssl=SSLContext.getInstance("TLS");ssl.init(km.getKeyManagers(),tm.getTrustManagers(),null);
            try(var client=HttpClient.newBuilder().sslContext(ssl).build()) {
                var response=get(client,privateBase(),PATH);assertThat(response.statusCode()).isEqualTo(401);sanitized(response.body());
            }
        }
    }
    @Test void missingClientCertificateFailsTlsHandshake() throws Exception {
        var trust=PemTls.trustStore(pki.resolve("ca.crt"));var tm=TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());tm.init(trust);
        var ssl=SSLContext.getInstance("TLS");ssl.init(null,tm.getTrustManagers(),null);
        try(var client=HttpClient.newBuilder().sslContext(ssl).build()) {
            assertThatThrownBy(()->get(client,privateBase(),PATH)).isInstanceOf(java.io.IOException.class);
        }
    }
    @Test void authorizedIdentityExportsOnlyBoundedGaugeLabels() throws Exception {
        assertThat(registry).isExactlyInstanceOf(io.micrometer.prometheusmetrics.PrometheusMeterRegistry.class);
        assertThat(context.getBeansOfType(PrivateMetricsController.class)).hasSize(1);
        assertThat(context.getEnvironment().getProperty("app.worker.diarization.enabled",Boolean.class)).isFalse();
        assertThat(context.getEnvironment().getProperty("app.media.processing.diarization-enabled",Boolean.class)).isFalse();
        try(var client=client("monitor")) {
            var response=get(client,privateBase(),PATH);assertThat(response.statusCode()).isEqualTo(200);
            Files.writeString(Path.of("target/spk12-prometheus.txt"),response.body());
            assertThat(response.headers().firstValue("Cache-Control")).hasValue("no-store");
            assertThat(response.body()).contains("# TYPE diarization_window_outcomes gauge","diarization_verified_only_outstanding", "diarization_metrics_aggregation_healthy 1.0");
            assertThat(response.body()).doesNotContain("# TYPE diarization_window_stage_duration histogram","jvm_","http_server_","meetingId","transcriptId","claimToken","objectKey");
            for(String line:response.body().lines().filter(l->!l.startsWith("#")&&!l.isBlank()).toList()) {
                assertThat(line).startsWith("diarization_");
                if(line.contains("{")) for(String tag:line.substring(line.indexOf('{')+1,line.indexOf('}')).split(","))
                    assertThat(tag.split("=")[0]).isIn("outcome","le","le_seconds","state");
            }
            var actual=response.body().lines().filter(l->!l.startsWith("#")&&!l.isBlank())
                .map(l->l.split("[ {]",2)[0]).collect(java.util.stream.Collectors.toSet());
            assertThat(actual).containsExactlyInAnyOrderElementsOf(
                List.of("diarization_window_outcomes","diarization_window_retries","diarization_window_stage_duration_count",
                    "diarization_window_stage_duration_seconds","diarization_window_stage_duration","diarization_window_accepted_measurements",
                    "diarization_window_speakers_sum","diarization_window_speakers","diarization_window_unknown_assignments_sum",
                    "diarization_window_unknown_assignments","diarization_window_lease_expirations","diarization_verified_only_outstanding",
                    "diarization_verified_only_count","diarization_verified_only_oldest_age_seconds","diarization_metrics_aggregation_healthy"));
        }
    }
    @Test void monitoringIdentityCannotClaimCompleteOrReadWorkerDeliveries() throws Exception {
        try(var client=client("monitor")) {
            String worker="/internal/v1/worker/processing-jobs/"+UUID.randomUUID()+"/diarization/";
            for(String action:List.of("claim","snapshot","renew","complete","fail")) {
                var response=client.send(HttpRequest.newBuilder(URI.create(privateBase()+worker+action)).header("Content-Type","application/json")
                    .POST(HttpRequest.BodyPublishers.ofString("{}")).build(),HttpResponse.BodyHandlers.ofString());
                assertThat(response.statusCode()).isEqualTo(403);sanitized(response.body());
            }
            assertThat(get(client,privateBase(),worker+"deliveries/"+UUID.randomUUID()).statusCode()).isEqualTo(403);
            for(String method:List.of("HEAD","POST","PUT","PATCH","DELETE","OPTIONS"))
                assertThat(client.send(HttpRequest.newBuilder(URI.create(privateBase()+PATH)).method(method,HttpRequest.BodyPublishers.noBody()).build(),HttpResponse.BodyHandlers.ofString()).statusCode()).isEqualTo(403);
            assertThat(get(client,privateBase(),"/actuator/health").statusCode()).isEqualTo(403);
        }
    }
    @Test void unexpectedSensitiveTagFailsClosedWithoutExportingItsValue() throws Exception {
        var meter=io.micrometer.core.instrument.Gauge.builder("diarization.window.outcomes",()->42)
            .tag("outcome","secret-meeting-identifier").register(registry);
        try(var client=client("monitor")) {
            var response=get(client,privateBase(),PATH);assertThat(response.statusCode()).isEqualTo(503);
            assertThat(response.body()).isEqualTo("Metrics unavailable.\n");
        } finally {registry.remove(meter);}
    }
    @Test void unapprovedNameCollidingWithAnExportedFamilyFailsClosed() throws Exception {
        var meter=io.micrometer.core.instrument.Gauge.builder("diarization_verified_only_count",()->99)
            .tag("state","private-meeting-value").register(registry);
        try(var client=client("monitor")) {
            var response=get(client,privateBase(),PATH);
            assertThat(response.statusCode()).isEqualTo(503);
            assertThat(response.body()).isEqualTo("Metrics unavailable.\n");
        } finally {registry.remove(meter);}
    }
    private void sanitized(String body) {assertThat(body).doesNotContain(pki.toString(),"PRIVATE KEY","password","certificate", "sourceRevision","DB_","Exception");}
}
