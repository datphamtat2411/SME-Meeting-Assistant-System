package com.sme.meetingassistant.api.transport;

import static org.assertj.core.api.Assertions.*;

import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.time.Duration;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;
import org.apache.catalina.connector.Connector;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;

/** Actual Tomcat/JSSE sockets and production Valve, without database or fake business controllers. */
class SecureTransportTests {
    @TempDir static Path pki;
    static final String ROUTE = "/internal/v1/worker/processing-jobs/11111111-1111-4111-8111-111111111111/transcription/claim";

    @BeforeAll static void certificates() throws Exception { TestPki.create(pki); }

    PrivateConnector.Settings settings() {
        return new PrivateConnector.Settings(true, "127.0.0.1", 0, "localhost",
            pki.resolve("server.crt"), pki.resolve("server.key"), pki.resolve("ca.crt"), pki.resolve("ca.crt"));
    }

    @Test void realConnectorRequiresWorkerCertificateAndIsolatesPublicRequests() throws Exception {
        var factory = new TomcatServletWebServerFactory(0);
        var connector = PrivateConnector.configure(factory, settings());
        var server = factory.getWebServer(context -> {
            var servlet = context.addServlet("transport-fixture", new HttpServlet() {
                @Override protected void service(HttpServletRequest req, HttpServletResponse res) throws java.io.IOException, jakarta.servlet.ServletException {
                    if (req.getRequestURI().equals("/forward-internal")) {
                        req.getRequestDispatcher(ROUTE).forward(req, res); return;
                    }
                    res.setStatus(204); // Test-only transport sink; no production worker operation.
                }
            });
            servlet.addMapping("/*");
        });
        server.start();
        try (var worker = client("worker", "ca")) {
            String privateUrl = "https://localhost:" + connector.getLocalPort();
            assertThat(send(worker, privateUrl + ROUTE, "POST")).isEqualTo(204);
            assertThat(send(worker, privateUrl + ROUTE, "POST")).isEqualTo(204); // keepalive
            assertThat(send(worker, privateUrl + ROUTE, "GET")).isEqualTo(403);
            assertThat(send(worker, privateUrl + "/internal/admin", "POST")).isEqualTo(403);
            assertThat(send(worker, privateUrl + "/internal/api/v1/meeting-intelligence/results/accept", "POST")).isEqualTo(403);
            assertThat(send(worker, privateUrl + "/api/v1/users", "GET")).isEqualTo(403);
            for (String identity : new String[]{"wrong", "ambiguous", "malformed", "missing-uri", "core"}) {
                try (var bad = client(identity, "ca")) {
                    assertThat(send(bad, privateUrl + ROUTE, "POST")).isIn(401, 403);
                }
            }
            for (String identity : new String[]{null, "untrusted", "expired", "wrong-purpose"}) {
                try (var bad = client(identity, "ca")) {
                    assertThatThrownBy(() -> send(bad, privateUrl + ROUTE, "POST")).isInstanceOf(java.io.IOException.class);
                }
            }
            try (var wrongCa = client("worker", "rogue-ca")) {
                assertThatThrownBy(() -> send(wrongCa, privateUrl + ROUTE, "POST")).isInstanceOf(java.io.IOException.class);
            }
            assertThatThrownBy(() -> send(worker, "https://127.0.0.1:" + connector.getLocalPort() + ROUTE, "POST"))
                .isInstanceOf(java.io.IOException.class);
            try (var plain = HttpClient.newHttpClient()) {
                String publicUrl = "http://localhost:" + server.getPort();
                for (String path : new String[]{ROUTE, "/internal", "/internal/", "/internal/api/v1/meeting-intelligence/results/accept",
                        "/%69nternal/admin", "/internal;ignored/admin", "/outside/../internal/admin"}) {
                    assertThat(send(plain, publicUrl + path, "POST")).isIn(400, 403);
                }
                assertThat(send(plain, publicUrl + "/api/v1/example", "GET")).isEqualTo(204);
                assertThat(send(plain, publicUrl + "/forward-internal", "POST")).isEqualTo(403);
                // Tomcat's TLS parser returns a fixed 400 for plaintext on an HTTPS socket;
                // the request never enters the application or authenticates a worker.
                assertThat(send(plain, privateUrl.replace("https:", "http:") + ROUTE, "POST")).isEqualTo(400);
            }
            try (var mi = client("mi", "ca")) {
                assertThat(send(mi, privateUrl + "/internal/api/v1/meeting-intelligence/results/accept", "POST")).isEqualTo(204);
                assertThat(send(mi, privateUrl + ROUTE, "POST")).isEqualTo(403);
            }
        } finally { server.stop(); server.destroy(); }
    }

    @Test void disabledModeStillDeniesPublicInternalPaths() throws Exception {
        var factory = new TomcatServletWebServerFactory(0);
        PrivateConnector.configure(factory, PrivateConnector.Settings.disabled());
        var server = factory.getWebServer(context -> {
            context.addServlet("test", new HttpServlet() {}).addMapping("/*");
        });
        server.start();
        try (var http = HttpClient.newHttpClient()) {
            assertThat(send(http, "http://localhost:" + server.getPort() + ROUTE, "POST")).isEqualTo(403);
        } finally { server.stop(); server.destroy(); }
    }

    @Test void invalidConfigurationFailsClosed() throws Exception {
        var good = settings();
        for (var bad : new PrivateConnector.Settings[]{
            new PrivateConnector.Settings(true, "127.0.0.1", 8443, "localhost", null, null, null, null),
            new PrivateConnector.Settings(true, "127.0.0.1", 8443, "wrong.internal", good.certificate(), good.key(), good.issuerCa(), good.clientCa()),
            new PrivateConnector.Settings(true, "127.0.0.1", 8443, "localhost", good.certificate(), pki.resolve("worker.key"), good.issuerCa(), good.clientCa()),
            new PrivateConnector.Settings(true, "127.0.0.1", 8443, "localhost", good.certificate(), good.key(), pki.resolve("rogue-ca.crt"), good.clientCa()),
            new PrivateConnector.Settings(true, "127.0.0.1", 8443, "localhost", good.certificate(), good.key(), good.issuerCa(), pki.resolve("absent"))}) {
            assertThatThrownBy(() -> PrivateConnector.configure(new TomcatServletWebServerFactory(0), bad))
                .isInstanceOf(IllegalStateException.class);
        }
        assertThatThrownBy(() -> new AiCoreTransport(URI.create("http://localhost:8000"), good.issuerCa(),
            pki.resolve("core.crt"), pki.resolve("core.key"), good.issuerCa())).isInstanceOf(IllegalStateException.class);
        for (String name : new String[]{"worker", "expired", "ambiguous", "wrong-purpose"}) {
            assertThatThrownBy(() -> new AiCoreTransport(URI.create("https://localhost:8000"), good.issuerCa(),
                pki.resolve(name + ".crt"), pki.resolve(name + ".key"), good.issuerCa()))
                .isInstanceOf(IllegalStateException.class);
        }
    }

    @Test void operationPolicyIsExactAndValidityIsRechecked() throws Exception {
        var leaf = PemTls.certificates(pki.resolve("worker.crt")).getFirst();
        assertThat(ServiceIdentity.from(leaf)).isEqualTo("urn:sme:service:ai-worker");
        // A request after notAfter fails even if its TLS session was established earlier.
        assertThatThrownBy(() -> ServiceIdentity.from(leaf, leaf.getNotAfter().toInstant().plusSeconds(1)))
            .isInstanceOf(java.security.cert.CertificateException.class);
        for (String op : new String[]{"claim", "renew", "complete", "fail"}) {
            assertThat(WorkerOperations.operation("POST", ROUTE.replace("/claim", "/" + op)))
                .isEqualTo("transcription." + op);
        }
        assertThat(WorkerOperations.operation("GET", ROUTE.replace("/claim", "/deliveries/22222222-2222-4222-8222-222222222222")))
            .isEqualTo("transcription.read-delivery");
        assertThat(WorkerOperations.allowed("urn:sme:service:ai-worker", "admin")).isFalse();
        assertThat(WorkerOperations.allowed("urn:sme:service:core-api", "transcription.claim")).isFalse();
    }

    static int send(HttpClient client, String url, String method) throws Exception {
        return client.send(HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(4))
            .header("X-Service-Identity", "urn:sme:service:ai-worker")
            .header("X-Forwarded-Client-Cert", "verified;URI=urn:sme:service:ai-worker")
            .header("X-Forwarded-Port", "8443").header("X-Forwarded-Proto", "https")
            .header("Authorization", "Bearer forged").method(method, HttpRequest.BodyPublishers.noBody()).build(),
            HttpResponse.BodyHandlers.discarding()).statusCode();
    }

    static HttpClient client(String identity, String ca) throws Exception {
        var trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        trust.init(PemTls.trustStore(pki.resolve(ca + ".crt")));
        var context = SSLContext.getInstance("TLS");
        javax.net.ssl.KeyManager[] keys = null;
        if (identity != null) {
            var chain = PemTls.certificates(pki.resolve(identity + ".crt"));
            var store = KeyStore.getInstance("PKCS12"); store.load(null, null);
            store.setKeyEntry("client", PemTls.privateKey(pki.resolve(identity + ".key"), "RSA"), new char[0],
                chain.toArray(java.security.cert.Certificate[]::new));
            var km = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
            km.init(store, new char[0]); keys = km.getKeyManagers();
        }
        context.init(keys, trust.getTrustManagers(), null);
        return HttpClient.newBuilder().sslContext(context).connectTimeout(Duration.ofSeconds(3)).build();
    }
}
