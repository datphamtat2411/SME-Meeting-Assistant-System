package com.sme.meetingassistant.api.transport;

import java.net.URI;
import java.nio.file.Path;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.core.env.Environment;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

@Configuration(proxyBeanMethods = false)
public class SecureTransportConfiguration {
    static Path path(Environment env, String name) {
        String value = env.getProperty(name);
        return value == null || value.isBlank() ? null : Path.of(value);
    }

    @Bean WebServerFactoryCustomizer<TomcatServletWebServerFactory> privateConnector(Environment env) {
        boolean enabled = env.getProperty("app.transport.private.enabled", Boolean.class, false);
        if (enabled && env.getProperty("app.transport.private.port", Integer.class, 8443)
                .equals(env.getProperty("server.port", Integer.class, 8080))) {
            throw new IllegalStateException("Public and private connector ports must differ");
        }
        return factory -> {
            if (!enabled && (env.getProperty("app.mi.internal-result.enabled", Boolean.class, false)
                    || env.getProperty("app.worker.transcription.enabled", Boolean.class, false)
                    || env.getProperty("app.worker.diarization.enabled", Boolean.class, false))) {
                throw new IllegalStateException("Internal receivers require the private mTLS connector");
            }
            PrivateConnector.configure(factory, !enabled ? PrivateConnector.Settings.disabled()
            : new PrivateConnector.Settings(true, env.getProperty("app.transport.private.address", "127.0.0.1"),
                env.getProperty("app.transport.private.port", Integer.class, 8443),
                env.getProperty("app.transport.private.hostname"),
                path(env, "app.transport.private.certificate"), path(env, "app.transport.private.key"),
                path(env, "app.transport.private.issuer-ca"), path(env, "app.transport.private.client-ca")));
        };
    }

    @Bean @Order(0)
    SecurityFilterChain workerTransportChain(HttpSecurity http) throws Exception {
        http.securityMatcher("/internal/v1/worker/**");
        http.sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        http.csrf(c -> c.disable());
        http.authorizeHttpRequests(a -> a.requestMatchers(PrivateConnector::workerAuthorized).permitAll().anyRequest().denyAll());
        return http.build();
    }

    @Bean(destroyMethod = "close")
    @ConditionalOnProperty(name = "app.transport.ai.enabled", havingValue = "true")
    AiCoreTransport aiCoreTransport(Environment env) {
        Path privateKey = path(env, "app.transport.private.key");
        Path clientKey = path(env, "app.transport.ai.key");
        try {
            if (privateKey != null && clientKey != null && java.nio.file.Files.isSameFile(privateKey, clientKey)) {
                throw new IllegalStateException("Dedicated outbound key required");
            }
            Path serverCert = path(env, "app.transport.private.certificate");
            Path clientCert = path(env, "app.transport.ai.certificate");
            if (serverCert != null && clientCert != null && java.util.Arrays.equals(
                    PemTls.certificates(serverCert).getFirst().getPublicKey().getEncoded(),
                    PemTls.certificates(clientCert).getFirst().getPublicKey().getEncoded())) {
                throw new IllegalStateException("Dedicated outbound key required");
            }
        } catch (Exception e) { throw new IllegalStateException("Invalid dedicated outbound key configuration"); }
        return new AiCoreTransport(URI.create(env.getRequiredProperty("app.transport.ai.base-url")),
            path(env, "app.transport.ai.server-ca"), path(env, "app.transport.ai.certificate"), clientKey,
            path(env, "app.transport.ai.issuer-ca"));
    }

    @Bean
    @ConditionalOnProperty(name = "app.transport.ai.probe", havingValue = "true")
    ApplicationRunner aiReadinessProbe(AiCoreTransport transport) {
        return args -> { transport.requireReady(); System.out.println("PASS core-api-to-ai readiness (Java mTLS)"); };
    }
}
