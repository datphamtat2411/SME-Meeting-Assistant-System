package com.sme.meetingassistant.api.transport;

import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.assertj.core.api.Assertions.*;

import java.net.URI;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import com.sme.meetingassistant.api.media.storage.S3ObjectStorageAdapter;

/** Opt-in, read-only shared-environment acceptance. No queue/object creation or business calls. */
class LiveSecureTransportTests {
    static String env(String key) { return System.getenv(key); }
    static Path file(String key) { return Path.of(java.util.Objects.requireNonNull(env(key), key + " required")); }
    static void enabled() {
        assumeTrue("true".equals(env("E2E01_LIVE")), "BLOCKED: E2E01_LIVE and approved shared-CA workload material required");
    }
    static void infrastructureEnabled() {
        assumeTrue("true".equals(env("E2E01_LIVE")) || "true".equals(env("E2E01_INFRA_FIXTURE")),
            "BLOCKED: approved live infrastructure or explicitly isolated real-service fixture required");
    }

    @Test void sharedCaJavaToAiReady() throws Exception {
        enabled();
        try (var transport = new AiCoreTransport(URI.create(env("APP_TRANSPORT_AI_BASE_URL")),
            file("APP_TRANSPORT_AI_SERVER_CA"), file("APP_TRANSPORT_AI_CERTIFICATE"),
            file("APP_TRANSPORT_AI_KEY"), file("APP_TRANSPORT_AI_ISSUER_CA"))) {
            transport.requireReady();
        }
    }

    @Test void javaAmqpsHandshakeAndLogin() throws Exception {
        infrastructureEnabled();
        var factory = new com.rabbitmq.client.ConnectionFactory();
        factory.setHost(env("RABBITMQ_HOST"));
        factory.setPort(Integer.parseInt(env("RABBITMQ_PORT")));
        assertThat(factory.getPort()).isNotEqualTo(5672);
        factory.setUsername(env("RABBITMQ_USERNAME")); factory.setPassword(env("RABBITMQ_PASSWORD"));
        factory.setVirtualHost(env("RABBITMQ_VIRTUAL_HOST"));
        var context = javax.net.ssl.SSLContext.getInstance("TLS");
        context.init(null, new javax.net.ssl.TrustManager[]{PemTls.trustManager(file("RABBITMQ_CA_FILE"))}, null);
        factory.useSslProtocol(context); factory.enableHostnameVerification();
        factory.setConnectionTimeout(5000); factory.setAutomaticRecoveryEnabled(false);
        try (var connection = factory.newConnection("e2e01-java-transport")) {
            assertThat(connection.isOpen()).isTrue();
        }
    }

    @Test void javaAwsSdkVerifiedHttpsRead() {
        infrastructureEnabled();
        try (var client = software.amazon.awssdk.services.s3.S3Client.builder()
            .endpointOverride(URI.create(env("APP_MEDIA_STORAGE_ENDPOINT")))
            .region(software.amazon.awssdk.regions.Region.of(env("APP_MEDIA_STORAGE_REGION")))
            .forcePathStyle(true)
            .credentialsProvider(software.amazon.awssdk.auth.credentials.StaticCredentialsProvider.create(
                software.amazon.awssdk.auth.credentials.AwsBasicCredentials.create(env("APP_MEDIA_STORAGE_ACCESS_KEY"), env("APP_MEDIA_STORAGE_SECRET_KEY"))))
            .httpClientBuilder(S3ObjectStorageAdapter.verifiedHttps(env("APP_MEDIA_STORAGE_ENDPOINT"), file("APP_MEDIA_STORAGE_CA_FILE")))
            .build()) {
            client.headObject(b -> b.bucket(env("APP_MEDIA_STORAGE_BUCKET")).key(env("E2E01_STORAGE_PROBE_KEY")));
        }
    }

    @Test void javaBrokerAndStorageRejectWrongTrustAndHostname() throws Exception {
        infrastructureEnabled();
        assumeTrue(env("E2E01_WRONG_CA_FILE") != null, "BLOCKED: unrelated external CA required for live negatives");
        // Wrong DNS name must resolve to the SAME endpoint, not merely fail DNS/connect.
        assumeTrue(env("E2E01_WRONG_BROKER_HOST") != null && env("E2E01_WRONG_STORAGE_URL") != null,
            "BLOCKED: resolvable wrong-host targets required for Java SDK negative checks");
        for (boolean wrongCa : new boolean[]{true, false}) {
            var factory = new com.rabbitmq.client.ConnectionFactory();
            factory.setHost(env(wrongCa ? "RABBITMQ_HOST" : "E2E01_WRONG_BROKER_HOST"));
            factory.setPort(Integer.parseInt(env("RABBITMQ_PORT")));
            factory.setUsername(env("RABBITMQ_USERNAME")); factory.setPassword(env("RABBITMQ_PASSWORD"));
            factory.setVirtualHost(env("RABBITMQ_VIRTUAL_HOST"));
            var ssl = javax.net.ssl.SSLContext.getInstance("TLS");
            ssl.init(null, new javax.net.ssl.TrustManager[]{PemTls.trustManager(file(wrongCa ? "E2E01_WRONG_CA_FILE" : "RABBITMQ_CA_FILE"))}, null);
            factory.useSslProtocol(ssl); factory.enableHostnameVerification(); factory.setConnectionTimeout(3000);
            factory.setAutomaticRecoveryEnabled(false);
            assertThatThrownBy(factory::newConnection).isInstanceOf(javax.net.ssl.SSLException.class);

            String url = env(wrongCa ? "APP_MEDIA_STORAGE_ENDPOINT" : "E2E01_WRONG_STORAGE_URL");
            try (var client = software.amazon.awssdk.services.s3.S3Client.builder()
                .endpointOverride(URI.create(url)).region(software.amazon.awssdk.regions.Region.US_EAST_1).forcePathStyle(true)
                .overrideConfiguration(c -> c.apiCallTimeout(java.time.Duration.ofSeconds(5)))
                .credentialsProvider(software.amazon.awssdk.auth.credentials.StaticCredentialsProvider.create(
                    software.amazon.awssdk.auth.credentials.AwsBasicCredentials.create(env("APP_MEDIA_STORAGE_ACCESS_KEY"), env("APP_MEDIA_STORAGE_SECRET_KEY"))))
                .httpClientBuilder(S3ObjectStorageAdapter.verifiedHttps(url, file(wrongCa ? "E2E01_WRONG_CA_FILE" : "APP_MEDIA_STORAGE_CA_FILE")))
                .build()) {
                assertThatThrownBy(() -> client.headObject(b -> b.bucket(env("APP_MEDIA_STORAGE_BUCKET")).key(env("E2E01_STORAGE_PROBE_KEY"))))
                    .isInstanceOf(software.amazon.awssdk.core.exception.SdkClientException.class)
                    .satisfies(error -> {
                        boolean tlsFailure = false;
                        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
                            if (cause instanceof javax.net.ssl.SSLException) tlsFailure = true;
                        }
                        assertThat(tlsFailure).as("TLS rejection, not DNS/connect failure").isTrue();
                    });
            }
        }
    }
}
