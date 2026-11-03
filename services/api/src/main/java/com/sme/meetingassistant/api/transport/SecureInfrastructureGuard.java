package com.sme.meetingassistant.api.transport;

import java.net.URI;
import java.nio.file.Path;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.context.annotation.Profile;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/** Secure mode cannot be silently downgraded by a higher-precedence environment value. */
@Component
@Profile("secure-integration")
final class SecureInfrastructureGuard implements InitializingBean {
    private final Environment env;
    SecureInfrastructureGuard(Environment env) { this.env = env; }

    @Override public void afterPropertiesSet() throws Exception {
        for (String property : new String[]{"app.transport.private.enabled", "app.transport.ai.enabled",
                "spring.rabbitmq.ssl.enabled", "spring.rabbitmq.ssl.validate-server-certificate", "spring.rabbitmq.ssl.verify-hostname"}) {
            if (!env.getProperty(property, Boolean.class, false)) throw new IllegalStateException("Secure integration TLS required");
        }
        if (!"integration-broker".equals(env.getProperty("spring.rabbitmq.ssl.bundle"))
                || !env.getProperty("spring.rabbitmq.addresses", "").isBlank()
                || env.getProperty("spring.rabbitmq.port", Integer.class, 5672) == 5672) {
            throw new IllegalStateException("Explicit verified AMQPS configuration required");
        }
        for (String property : new String[]{"spring.rabbitmq.username", "spring.rabbitmq.password", "spring.rabbitmq.virtual-host",
                "app.media.storage.access-key", "app.media.storage.secret-key"}) {
            if (env.getRequiredProperty(property).isBlank()) throw new IllegalStateException("External service credentials required");
        }
        if (!"https".equals(URI.create(env.getRequiredProperty("app.media.storage.endpoint")).getScheme())) {
            throw new IllegalStateException("S3 HTTPS required");
        }
        PemTls.trustStore(Path.of(env.getRequiredProperty("app.media.storage.ca-file")));
        PemTls.trustStore(Path.of(env.getRequiredProperty("RABBITMQ_CA_FILE")));
    }
}
