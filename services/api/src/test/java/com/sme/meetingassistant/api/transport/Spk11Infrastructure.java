package com.sme.meetingassistant.api.transport;

import com.sme.meetingassistant.api.media.storage.S3ObjectStorageAdapter;
import java.nio.file.*;
import java.time.Duration;
import java.util.Comparator;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import org.springframework.amqp.rabbit.connection.CachingConnectionFactory;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.Network;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.utility.MountableFile;
import software.amazon.awssdk.auth.credentials.*;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.*;

/** Disposable SPK-11 resources only; no fixed ports, shared volumes, or external credentials. */
final class Spk11Infrastructure implements AutoCloseable {
    static final String USER = "spk11-test";
    static final String PASSWORD = "spk11-synthetic-only-password";
    static final String BUCKET = "spk11-media";
    final Path directory;
    final Network network = Network.newNetwork();
    final PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:17");
    GenericContainer<?> broker, storage, boundary;
    S3Client s3;

    Spk11Infrastructure() throws Exception {
        directory = Files.createTempDirectory("spk11-");
        try {
            TestPki.run(directory, "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
                "-subj", "/CN=SPK11 disposable CA", "-keyout", "ca.key", "-out", "ca.crt");
            for (String server : new String[]{"server", "storage", "broker"})
                TestPki.issue(directory, server, "DNS:localhost", "serverAuth", "ca", false);
            TestPki.issue(directory, "worker", "URI:urn:sme:service:ai-worker", "clientAuth", "ca", false);
            TestPki.issue(directory, "core", "URI:urn:sme:service:core-api", "clientAuth", "ca", false);

            var root = Path.of("../..").toAbsolutePath().normalize();
            String rabbit = Files.readString(root.resolve("infra/local/secure-integration/rabbitmq.conf"));
            Files.writeString(directory.resolve("rabbitmq.conf"), rabbit);
            broker = new GenericContainer<>("rabbitmq:4.1-management")
                .withEnv("RABBITMQ_DEFAULT_USER", USER).withEnv("RABBITMQ_DEFAULT_PASS", PASSWORD)
                .withExposedPorts(5671).withCopyFileToContainer(file("rabbitmq.conf"), "/etc/rabbitmq/rabbitmq.conf")
                .withCopyFileToContainer(file("broker.crt"), "/run/secrets/broker/tls.crt")
                .withCopyFileToContainer(file("broker.key"), "/run/secrets/broker/tls.key")
                .withCopyFileToContainer(file("ca.crt"), "/run/secrets/broker/issuer-ca.crt")
                .waitingFor(Wait.forLogMessage(".*Server startup complete.*", 1)).withStartupTimeout(Duration.ofMinutes(2));
            storage = new GenericContainer<>("rustfs/rustfs:1.0.3").withNetwork(network).withNetworkAliases("storage")
                .withCreateContainerCmdModifier(command->command.withUser("0:0"))
                .withEnv("RUSTFS_ACCESS_KEY", USER).withEnv("RUSTFS_SECRET_KEY", PASSWORD)
                .withEnv("RUSTFS_ADDRESS", ":9000").withEnv("RUSTFS_CONSOLE_ENABLE", "false")
                .withEnv("RUSTFS_TLS_PATH", "/run/secrets/storage").withCommand("/data")
                .withCopyFileToContainer(file("storage.crt"), "/run/secrets/storage/rustfs_cert.pem")
                .withCopyFileToContainer(file("storage.key"), "/run/secrets/storage/rustfs_key.pem")
                .withCopyFileToContainer(file("ca.crt"), "/run/secrets/storage/issuer-ca.crt")
                .waitingFor(Wait.forSuccessfulCommand("curl --fail --silent --cacert /run/secrets/storage/issuer-ca.crt https://localhost:9000/health"))
                .withStartupTimeout(Duration.ofMinutes(2));
            // Reuse the approved immutable-write proxy, with only the disposable DNS identity changed.
            Files.writeString(directory.resolve("storage-boundary.conf"), Files.readString(
                root.resolve("infra/local/secure-integration/storage-boundary.conf")).replace("storage.internal", "localhost"));
            boundary = new GenericContainer<>("nginx:1.28-alpine").withNetwork(network).withExposedPorts(9000)
                .withCopyFileToContainer(file("storage-boundary.conf"), "/etc/nginx/storage-boundary.conf")
                .withCopyFileToContainer(file("storage.crt"), "/run/secrets/storage/rustfs_cert.pem")
                .withCopyFileToContainer(file("storage.key"), "/run/secrets/storage/rustfs_key.pem")
                .withCopyFileToContainer(file("ca.crt"), "/run/secrets/storage/issuer-ca.crt")
                .withCommand("nginx", "-c", "/etc/nginx/storage-boundary.conf", "-g", "daemon off;");
            postgres.start(); broker.start(); storage.start(); boundary.start();
            s3 = S3Client.builder().endpointOverride(java.net.URI.create(storageUrl())).region(Region.US_EAST_1)
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(USER, PASSWORD)))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build())
                .httpClientBuilder(S3ObjectStorageAdapter.verifiedHttps(storageUrl(), directory.resolve("ca.crt"))).build();
            s3.createBucket(b -> b.bucket(BUCKET));
        } catch (Exception failure) {
            close(); throw failure;
        }
    }

    private MountableFile file(String name) { return MountableFile.forHostPath(directory.resolve(name), 0444); }
    String storageUrl() { return "https://localhost:" + boundary.getMappedPort(9000); }

    CachingConnectionFactory rabbit() throws Exception {
        var client = new com.rabbitmq.client.ConnectionFactory();
        client.setHost("localhost"); client.setPort(broker.getMappedPort(5671));
        client.setUsername(USER); client.setPassword(PASSWORD);
        var tls = SSLContext.getInstance("TLS");
        tls.init(null, new TrustManager[]{PemTls.trustManager(directory.resolve("ca.crt"))}, null);
        client.useSslProtocol(tls); client.enableHostnameVerification();
        var factory = new CachingConnectionFactory(client);
        factory.setPublisherConfirmType(CachingConnectionFactory.ConfirmType.CORRELATED);
        factory.setPublisherReturns(true);
        return factory;
    }

    @Override public void close() throws Exception {
        if (s3 != null) s3.close();
        for (var container : new GenericContainer<?>[]{boundary, storage, broker, postgres})
            if (container != null) container.stop();
        network.close();
        if (Files.exists(directory)) try (var paths = Files.walk(directory)) {
            for (var path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
        }
    }
}
