package com.sme.meetingassistant.api.transport;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.time.Duration;
import javax.net.ssl.SSLParameters;

/** One externally configured credential snapshot; recreate/close on controlled rotation. */
public final class AiCoreTransport implements AutoCloseable {
    private final URI base;
    private final HttpClient client;

    public AiCoreTransport(URI base, Path serverCa, Path certificate, Path key, Path clientIssuerCa) {
        if (base == null || !"https".equals(base.getScheme()) || base.getHost() == null
                || base.getRawUserInfo() != null || base.getRawQuery() != null || base.getRawFragment() != null
                || !(base.getPath().isEmpty() || base.getPath().equals("/"))) {
            throw new IllegalStateException("AI Core requires an HTTPS origin");
        }
        this.base = base;
        var parameters = new SSLParameters();
        parameters.setProtocols(new String[]{"TLSv1.3", "TLSv1.2"});
        parameters.setEndpointIdentificationAlgorithm("HTTPS");
        client = HttpClient.newBuilder().sslContext(PemTls.clientContext(certificate, key, clientIssuerCa,
                serverCa, "urn:sme:service:core-api"))
            .sslParameters(parameters).connectTimeout(Duration.ofSeconds(3))
            .followRedirects(HttpClient.Redirect.NEVER).version(HttpClient.Version.HTTP_1_1).build();
    }

    public HttpResponse<String> get(String path) throws IOException, InterruptedException {
        if (path == null || !path.startsWith("/") || path.startsWith("//") || path.contains("\\")) {
            throw new IllegalArgumentException("Origin-relative AI path required");
        }
        URI target = base.resolve(path);
        if (!base.getScheme().equals(target.getScheme()) || !base.getRawAuthority().equals(target.getRawAuthority())) {
            throw new IllegalArgumentException("AI origin cannot change");
        }
        return client.send(HttpRequest.newBuilder(target).timeout(Duration.ofSeconds(15))
            .header("Accept", "application/json").GET().build(), HttpResponse.BodyHandlers.ofString());
    }

    public void requireReady() throws IOException, InterruptedException {
        var response = get("/health/ready");
        if (response.statusCode() != 200 || !response.body().matches("\\s*\\{\\s*\"status\"\\s*:\\s*\"ready\"\\s*}\\s*")) {
            throw new IOException("AI readiness check failed");
        }
    }

    @Override public void close() { client.close(); }
}
