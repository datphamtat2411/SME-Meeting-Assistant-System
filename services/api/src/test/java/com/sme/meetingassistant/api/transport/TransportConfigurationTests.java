package com.sme.meetingassistant.api.transport;

import static org.assertj.core.api.Assertions.*;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;

class TransportConfigurationTests {
    @Test void internalReceiverCannotBeEnabledWithoutPrivateConnector() {
        var config = new SecureTransportConfiguration();
        for (String gate : new String[]{"app.mi.internal-result.enabled", "app.worker.transcription.enabled"}) {
            var customizer = config.privateConnector(new MockEnvironment().withProperty(gate, "true"));
            assertThatThrownBy(() -> customizer.customize(new TomcatServletWebServerFactory()))
                .isInstanceOf(IllegalStateException.class);
        }
    }

    @Test void disabledDefaultsDoNotLoadAnyTlsMaterial() {
        var config = new SecureTransportConfiguration();
        config.privateConnector(new MockEnvironment()).customize(new TomcatServletWebServerFactory());
    }

    @Test void samePublicAndPrivatePortIsRejected() {
        assertThatThrownBy(() -> new SecureTransportConfiguration().privateConnector(new MockEnvironment()
            .withProperty("app.transport.private.enabled", "true").withProperty("app.transport.private.port", "8080")))
            .isInstanceOf(IllegalStateException.class);
    }

    @Test void secureProfileRejectsCertificateVerificationDowngrade() {
        var env = new MockEnvironment().withProperty("app.transport.private.enabled", "true")
            .withProperty("app.transport.ai.enabled", "true").withProperty("spring.rabbitmq.ssl.enabled", "true")
            .withProperty("spring.rabbitmq.ssl.validate-server-certificate", "true")
            .withProperty("spring.rabbitmq.ssl.verify-hostname", "false");
        assertThatThrownBy(() -> new SecureInfrastructureGuard(env).afterPropertiesSet())
            .isInstanceOf(IllegalStateException.class);
    }

    @Test void explicitStorageTrustNeverAllowsHttp() {
        assertThatThrownBy(() -> com.sme.meetingassistant.api.media.storage.S3ObjectStorageAdapter.verifiedHttps(
            "http://storage.internal:9000", java.nio.file.Path.of("/absent")))
            .isInstanceOf(IllegalStateException.class);
    }
}
