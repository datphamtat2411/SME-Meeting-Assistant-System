package com.sme.meetingassistant.api.transport;

import static org.assertj.core.api.Assertions.*;
import com.rabbitmq.client.Address;
import java.io.IOException;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;
import org.springframework.amqp.rabbit.connection.CachingConnectionFactory;

class TransportConfigurationTests {
    private static final class ExposedCachingConnectionFactory extends CachingConnectionFactory {
        ExposedCachingConnectionFactory(com.rabbitmq.client.ConnectionFactory target) {
            super(target);
        }

        List<Address> configuredAddresses() throws IOException {
            return getAddresses();
        }
    }

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

    @Test void loopbackTlsRouteRejectsUnexpectedDestinationOrIdentity() {
        var ssl = (javax.net.ssl.SSLSocketFactory) javax.net.ssl.SSLSocketFactory.getDefault();
        assertThatThrownBy(() -> new LoopbackTlsSocketFactory(
            ssl, "127.0.0.2", "rabbitmq.internal", 3000))
            .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new LoopbackTlsSocketFactory(
            ssl, "127.0.0.1", "rabbit mq.internal", 3000))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test void isolatedRabbitRouteUsesLoopbackTcpDestinationWithConfiguredTlsIdentity() throws Exception {
        var env = new MockEnvironment()
            .withProperty("RABBITMQ_CONNECT_HOST", "127.0.0.1")
            .withProperty("RABBITMQ_TLS_SERVER_NAME", "rabbitmq.internal")
            .withProperty("spring.rabbitmq.host", "rabbitmq.internal");
        var factory = new com.rabbitmq.client.ConnectionFactory();
        factory.useSslProtocol();

        new SecureTransportConfiguration().isolatedRabbitLoopbackRoute(env).customize(factory);

        assertThat(factory.getHost()).isEqualTo("127.0.0.1");
        assertThat(factory.getSocketFactory()).isInstanceOf(LoopbackTlsSocketFactory.class);
        try (var socket = factory.getSocketFactory().createSocket()) {
            assertThat(socket).isInstanceOf(javax.net.ssl.SSLSocket.class);
            assertThat(((javax.net.ssl.SSLSocket) socket).getSSLParameters()
                .getEndpointIdentificationAlgorithm()).isEqualTo("HTTPS");
        }
    }

    @Test void isolatedRabbitRouteRewritesSpringAddressListAfterBootConfiguration() throws Exception {
        var env = new MockEnvironment()
            .withProperty("RABBITMQ_CONNECT_HOST", "127.0.0.1")
            .withProperty("RABBITMQ_TLS_SERVER_NAME", "rabbitmq.internal")
            .withProperty("RABBITMQ_PORT", "5671")
            .withProperty("spring.rabbitmq.host", "rabbitmq.internal");
        var target = new com.rabbitmq.client.ConnectionFactory();
        target.useSslProtocol();
        new SecureTransportConfiguration().isolatedRabbitLoopbackRoute(env).customize(target);
        var caching = new ExposedCachingConnectionFactory(target);

        new SecureTransportConfiguration().isolatedRabbitAddressListRoute(env)
            .postProcessAfterInitialization(caching, "rabbitConnectionFactory");

        assertThat(caching.configuredAddresses())
            .singleElement()
            .satisfies(address -> {
                assertThat(address.getHost()).isEqualTo("127.0.0.1");
                assertThat(address.getPort()).isEqualTo(5671);
            });
    }
}
