package com.sme.meetingassistant.api.transport;

import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.net.InetAddress;
import java.nio.file.Path;
import java.security.cert.X509Certificate;
import org.apache.catalina.connector.Connector;
import org.apache.catalina.connector.Request;
import org.apache.catalina.connector.Response;
import org.apache.catalina.valves.ValveBase;
import org.apache.coyote.http11.Http11NioProtocol;
import org.apache.tomcat.util.net.SSLHostConfig;
import org.apache.tomcat.util.net.SSLHostConfigCertificate;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;

public final class PrivateConnector {
    private PrivateConnector() {}
    private static final String ATTESTATION = PrivateConnector.class.getName() + ".verified";
    private record Attestation(String principal, X509Certificate leaf) {}

    public record Settings(boolean enabled, String address, int port, String hostname,
            Path certificate, Path key, Path issuerCa, Path clientCa) {
        public static Settings disabled() { return new Settings(false, null, 0, null, null, null, null, null); }
    }

    public static Connector configure(TomcatServletWebServerFactory factory, Settings settings) {
        return configure(factory, settings, false);
    }

    public static Connector configure(TomcatServletWebServerFactory factory, Settings settings, boolean monitoring) {
        if (monitoring && !settings.enabled()) throw new IllegalStateException("Private monitoring requires mTLS");
        Connector connector = null;
        if (settings.enabled()) {
            try {
                if (settings.port() < 0 || settings.port() > 65535 || settings.address() == null
                        || settings.address().isBlank() || settings.hostname() == null || settings.hostname().isBlank()) {
                    throw new IllegalStateException();
                }
                var identity = PemTls.identity(settings.certificate(), settings.key(), settings.issuerCa(), PemTls.SERVER_AUTH, settings.hostname());
                var host = new SSLHostConfig();
                host.setProtocols("TLSv1.3,+TLSv1.2");
                host.setCertificateVerification("required");
                host.setTrustStore(PemTls.trustStore(settings.clientCa()));
                var cert = new SSLHostConfigCertificate(host, SSLHostConfigCertificate.Type.UNDEFINED);
                cert.setCertificateKeystore(identity);
                cert.setCertificateKeystorePassword("");
                cert.setCertificateKeyPassword("");
                cert.setCertificateKeyAlias("workload");
                host.addCertificate(cert);
                connector = new Connector(Http11NioProtocol.class.getName());
                var protocol = (Http11NioProtocol) connector.getProtocolHandler();
                protocol.setAddress(InetAddress.getByName(settings.address()));
                protocol.setSSLEnabled(true);
                protocol.setSslImplementationName("org.apache.tomcat.util.net.jsse.JSSEImplementation");
                connector.setPort(settings.port()); connector.setScheme("https"); connector.setSecure(true);
                connector.addSslHostConfig(host);
                factory.addAdditionalConnectors(connector);
            } catch (Exception e) { throw new IllegalStateException("Invalid private mTLS connector configuration"); }
        }
        // Always installed, even with the private connector disabled.
        factory.addEngineValves(new BoundaryValve(connector, monitoring));
        // A RequestDispatcher forward/include does not revisit the engine pipeline.
        // Guard every servlet dispatch as well, using only the Valve's in-process attestation.
        factory.addInitializers(context -> context.addFilter("internal-dispatch-boundary", (request, response, chain) -> {
            var http = (HttpServletRequest) request;
            String path = http.getServletPath() + (http.getPathInfo() == null ? "" : http.getPathInfo());
            if ((path.equals("/internal") || path.startsWith("/internal/")) && !dispatchAuthorized(http, path)) {
                var res = (jakarta.servlet.http.HttpServletResponse) response;
                deny(res, 403, "AUTHZ_FORBIDDEN");
                return;
            }
            chain.doFilter(request, response);
        }).addMappingForUrlPatterns(java.util.EnumSet.allOf(jakarta.servlet.DispatcherType.class), false, "/*"));
        return connector;
    }

    private static boolean dispatchAuthorized(HttpServletRequest request, String path) {
        if (!(request.getAttribute(ATTESTATION) instanceof Attestation attestation)) return false;
        try {
            if (!attestation.principal().equals(ServiceIdentity.from(attestation.leaf()))) return false;
            return WorkerOperations.allowed(attestation.principal(), WorkerOperations.operation(request.getMethod(), path))
                || monitoringAuthorized(request)
                || ("urn:sme:service:mi-worker".equals(attestation.principal())
                    && path.startsWith("/internal/api/v1/meeting-intelligence/"));
        } catch (Exception e) { return false; }
    }

    /** Request attributes are in-process attestations; no header can create one. */
    public static boolean workerAuthorized(HttpServletRequest request) {
        Object value = request.getAttribute(ATTESTATION);
        if (!(value instanceof Attestation attestation)) return false;
        try {
            return attestation.principal().equals(ServiceIdentity.from(attestation.leaf()))
                && WorkerOperations.allowed(attestation.principal(), WorkerOperations.operation(request.getMethod(), request.getServletPath()));
        } catch (Exception e) { return false; }
    }

    /** Original claim replay is bound to a JSSE-verified certificate, never a caller header. */
    public static String workerCertificateFingerprint(HttpServletRequest request) {
        if(!workerAuthorized(request)) throw new SecurityException("Authenticated worker required");
        var attestation=(Attestation)request.getAttribute(ATTESTATION);
        try {return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(attestation.leaf().getEncoded()));}
        catch(Exception invalid) {throw new SecurityException("Authenticated worker required");}
    }

    /** Canonical Action Item ingress uses the independently bearer-protected MI route. */
    public static String actionItemWorkerCertificateFingerprint(HttpServletRequest request) {
        if (!(request.getAttribute(ATTESTATION) instanceof Attestation attestation)
                || !"POST".equals(request.getMethod())
                || !"/internal/api/v1/meeting-intelligence/action-items/accept".equals(request.getServletPath())) {
            throw new SecurityException("Authenticated worker required");
        }
        try {
            if (!"urn:sme:service:mi-worker".equals(attestation.principal())
                    || !attestation.principal().equals(ServiceIdentity.from(attestation.leaf()))) {
                throw new SecurityException();
            }
            return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                .digest(attestation.leaf().getEncoded()));
        } catch (Exception invalid) {throw new SecurityException("Authenticated worker required");}
    }

    public static final String METRICS_PATH = "/internal/monitoring/prometheus";

    /** No worker permissions, headers, JWTs or browser sessions establish this identity. */
    public static boolean monitoringAuthorized(HttpServletRequest request) {
        if (!(request.getAttribute(ATTESTATION) instanceof Attestation attestation)) return false;
        try {
            return attestation.principal().equals(ServiceIdentity.from(attestation.leaf()))
                && monitorOperation(attestation.principal(), request.getMethod(), request.getServletPath());
        } catch (Exception e) { return false; }
    }

    private static boolean monitorOperation(String principal, String method, String path) {
        return "urn:sme:service:monitoring".equals(principal) && "GET".equals(method) && METRICS_PATH.equals(path);
    }

    private static void deny(jakarta.servlet.http.HttpServletResponse response, int status, String code) throws IOException {
        response.setStatus(status); response.setContentType("application/json");
        response.setHeader("Cache-Control", "no-store");
        response.getWriter().write("{\"success\":false,\"code\":\"" + code
            + "\",\"message\":\"Internal transport access denied.\",\"data\":null,\"meta\":{\"requestId\":\""
            + java.util.UUID.randomUUID() + "\",\"timestamp\":\"" + java.time.Instant.now() + "\"}}");
    }

    private static final class BoundaryValve extends ValveBase {
        private final Connector privateConnector;
        private final boolean monitoring;
        BoundaryValve(Connector connector, boolean monitoring) { super(true); privateConnector = connector; this.monitoring = monitoring; }

        @Override public void invoke(Request request, Response response) throws IOException, ServletException {
            request.removeAttribute(ATTESTATION);
            // Tomcat's decoded, normalized mapping path removes path parameters before this Valve.
            String path = request.getDecodedRequestURI();
            String context = request.getContextPath();
            if (!context.isEmpty()) path = path.substring(context.length());
            if (path.equals("/actuator/prometheus") || path.startsWith("/actuator/prometheus/")
                    || path.equals("/actuator/metrics") || path.startsWith("/actuator/metrics/")) {
                deny(response, 403, "AUTHZ_FORBIDDEN"); return;
            }
            boolean internal = path.equals("/internal") || path.startsWith("/internal/");
            boolean privateRequest = privateConnector != null && request.getConnector() == privateConnector;
            if (internal && !privateRequest || privateRequest && !internal) {
                deny(response, 403, "AUTHZ_FORBIDDEN"); return;
            }
            if (privateRequest) {
                response.setHeader("Cache-Control", "no-store");
                Object peer = request.getAttribute("jakarta.servlet.request.X509Certificate");
                String principal;
                X509Certificate leaf;
                try {
                    if (!request.isSecure() || !(peer instanceof X509Certificate[] chain) || chain.length == 0) {
                        throw new java.security.cert.CertificateException();
                    }
                    leaf = chain[0];
                    for (var certificate : chain) certificate.checkValidity();
                    principal = ServiceIdentity.from(leaf);
                } catch (Exception e) { deny(response, 401, "AUTH_REQUIRED"); return; }
                boolean worker = WorkerOperations.allowed(principal, WorkerOperations.operation(request.getMethod(), path));
                boolean mi = "urn:sme:service:mi-worker".equals(principal)
                    && path.startsWith("/internal/api/v1/meeting-intelligence/");
                boolean monitor = monitoring && monitorOperation(principal, request.getMethod(), path);
                if (!worker && !mi && !monitor) { deny(response, 403, "AUTHZ_FORBIDDEN"); return; }
                request.setAttribute(ATTESTATION, new Attestation(principal, leaf));
            }
            getNext().invoke(request, response);
        }

        private void deny(Response response, int status, String code) throws IOException {
            PrivateConnector.deny(response.getResponse(), status, code);
        }
    }
}
