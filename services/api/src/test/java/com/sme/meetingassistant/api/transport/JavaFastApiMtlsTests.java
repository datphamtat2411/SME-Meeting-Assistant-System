package com.sme.meetingassistant.api.transport;

import static org.assertj.core.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Real Java HTTP client -> existing unmodified FastAPI/Uvicorn entrypoint; isolated test PKI. */
class JavaFastApiMtlsTests {
    @TempDir Path pki;

    @Test void javaCallsExistingFastApiReadinessAndRejectsInvalidTls() throws Exception {
        Path ai = Path.of("../ai").toAbsolutePath().normalize();
        Path python = Path.of(System.getenv().getOrDefault("E2E01_AI_PYTHON", ai.resolve(".venv/bin/python").toString()));
        assumeTrue(Files.isExecutable(python), "BLOCKED: provision AI locked Python environment (uv sync --locked)");
        TestPki.create(pki);
        int port;
        try (var socket = new ServerSocket(0)) { port = socket.getLocalPort(); }
        var builder = new ProcessBuilder(python.toString(), "-m", "sme_meeting_ai.api").directory(ai.toFile())
            .redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD);
        builder.environment().keySet().removeIf(k -> k.startsWith("AI_"));
        builder.environment().putAll(java.util.Map.of(
            "AI_ENVIRONMENT", "development", "AI_HTTP_HOST", "127.0.0.1", "AI_HTTP_PORT", Integer.toString(port),
            "AI_TLS_CERT_FILE", pki.resolve("server.crt").toString(), "AI_TLS_KEY_FILE", pki.resolve("server.key").toString(),
            "AI_TLS_CLIENT_CA_FILE", pki.resolve("ca.crt").toString()));
        Process process = builder.start();
        URI origin = URI.create("https://localhost:" + port);
        try (var transport = new AiCoreTransport(origin, pki.resolve("ca.crt"), pki.resolve("core.crt"),
                pki.resolve("core.key"), pki.resolve("ca.crt"))) {
            boolean ready = false;
            for (int i = 0; i < 60 && process.isAlive(); i++) {
                try { transport.requireReady(); ready = true; break; }
                catch (java.io.IOException e) { Thread.sleep(100); }
            }
            assertThat(ready).as("Actual FastAPI readiness over Java mTLS (isolated PKI)").isTrue();
            transport.requireReady(); // same client pool, subsequent request
            for (String identity : new String[]{null, "untrusted", "expired", "wrong-purpose"}) {
                try (var bad = rawClient(identity, "ca")) {
                    assertThatThrownBy(() -> bad.send(HttpRequest.newBuilder(origin.resolve("/health/ready"))
                        .timeout(Duration.ofSeconds(3)).build(), HttpResponse.BodyHandlers.discarding()))
                        .isInstanceOf(java.io.IOException.class);
                }
            }
            try (var wrongTrust = new AiCoreTransport(origin, pki.resolve("rogue-ca.crt"), pki.resolve("core.crt"),
                    pki.resolve("core.key"), pki.resolve("ca.crt"))) {
                assertThatThrownBy(wrongTrust::requireReady).isInstanceOf(java.io.IOException.class);
            }
            try (var wrongHost = new AiCoreTransport(URI.create("https://127.0.0.1:" + port), pki.resolve("ca.crt"),
                    pki.resolve("core.crt"), pki.resolve("core.key"), pki.resolve("ca.crt"))) {
                assertThatThrownBy(wrongHost::requireReady).isInstanceOf(java.io.IOException.class);
            }
            // Readiness is intentionally operation-free in AI. The Java workload loader itself
            // requires core-api; protected AI operations retain their existing core-api policy.
            assertThatThrownBy(() -> new AiCoreTransport(origin, pki.resolve("ca.crt"), pki.resolve("worker.crt"),
                pki.resolve("worker.key"), pki.resolve("ca.crt"))).isInstanceOf(IllegalStateException.class);
            assertThatThrownBy(() -> new AiCoreTransport(origin, pki.resolve("ca.crt"), pki.resolve("core.crt"),
                pki.resolve("worker.key"), pki.resolve("ca.crt"))).isInstanceOf(IllegalStateException.class);
            // Start the same unmodified FastAPI listener with an expired server fixture.
            process.destroy();
            assertThat(process.waitFor(6, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            builder.environment().put("AI_TLS_CERT_FILE", pki.resolve("expired-server.crt").toString());
            builder.environment().put("AI_TLS_KEY_FILE", pki.resolve("expired-server.key").toString());
            process = builder.start();
            boolean listening = false;
            for (int i = 0; i < 60 && process.isAlive(); i++) {
                try (var socket = new java.net.Socket("127.0.0.1", port)) { listening = true; break; }
                catch (java.io.IOException e) { Thread.sleep(100); }
            }
            assertThat(listening).isTrue();
            // A new credential pool must reject expiry, independent of cached TLS sessions.
            try (var fresh = new AiCoreTransport(origin, pki.resolve("ca.crt"), pki.resolve("core.crt"),
                    pki.resolve("core.key"), pki.resolve("ca.crt"))) {
                assertThatThrownBy(fresh::requireReady).isInstanceOf(java.io.IOException.class);
            }
        } finally {
            process.destroy();
            if (!process.waitFor(6, java.util.concurrent.TimeUnit.SECONDS)) process.destroyForcibly();
        }
    }

    private java.net.http.HttpClient rawClient(String identity, String trust) throws Exception {
        var tm = javax.net.ssl.TrustManagerFactory.getInstance(javax.net.ssl.TrustManagerFactory.getDefaultAlgorithm());
        tm.init(PemTls.trustStore(pki.resolve(trust + ".crt")));
        javax.net.ssl.KeyManager[] keys = null;
        if (identity != null) {
            var ks = java.security.KeyStore.getInstance("PKCS12"); ks.load(null, null);
            ks.setKeyEntry("client", PemTls.privateKey(pki.resolve(identity + ".key"), "RSA"), new char[0],
                PemTls.certificates(pki.resolve(identity + ".crt")).toArray(java.security.cert.Certificate[]::new));
            var km = javax.net.ssl.KeyManagerFactory.getInstance(javax.net.ssl.KeyManagerFactory.getDefaultAlgorithm());
            km.init(ks, new char[0]); keys = km.getKeyManagers();
        }
        var ssl = javax.net.ssl.SSLContext.getInstance("TLS"); ssl.init(keys, tm.getTrustManagers(), null);
        return java.net.http.HttpClient.newBuilder().sslContext(ssl).connectTimeout(Duration.ofSeconds(3)).build();
    }
}
