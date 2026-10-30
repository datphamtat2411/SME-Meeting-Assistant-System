package com.sme.meetingassistant.api.media;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.media.outbox.MediaMessagingConfiguration;
import com.sme.meetingassistant.api.media.outbox.OutboxPublisher;
import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.media.validation.MediaInspector;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.nio.charset.StandardCharsets;
import java.security.Principal;
import java.util.Arrays;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.utility.DockerImageName;
import tools.jackson.databind.ObjectMapper;

/**
 * T08: real PostgreSQL, RustFS (S3), RabbitMQ and ffprobe.
 * Does not use mocks for storage, broker confirms or media inspection.
 *
 * Separate Docker instances are used instead of app-local infrastructure ports.
 * A real AI consumer is intentionally outside the phase-1 API boundary.
 */
@ActiveProfiles("test")
@SpringBootTest(properties = {
    "app.media.outbox.enabled=true",
    "app.media.outbox.poll-delay-ms=3600000",
    "app.media.outbox.max-attempts=3",
    "app.media.storage.bucket=t08-meeting-media",
    "app.media.storage.path-style-access=true",
    "app.media.storage.create-bucket-if-missing=true",
    "app.media.upload.allowed-extensions=wav",
    "app.media.upload.allowed-content-types=audio/wav",
    "app.media.upload.max-size-bytes=1048576",
    "app.media.upload.max-duration-ms=60000",
    "app.media.upload.upload-url-ttl=PT2M",
    "app.media.upload.download-url-ttl=PT1M"
})
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class MediaLiveInfrastructureIntegrationTests {
    private static final GenericContainer<?> RABBITMQ = new GenericContainer<>(
        DockerImageName.parse("rabbitmq:4.1-management"))
        .withExposedPorts(5672)
        .withEnv("RABBITMQ_DEFAULT_USER", "t08")
        .withEnv("RABBITMQ_DEFAULT_PASS", "t08-rabbit-password")
        .waitingFor(Wait.forListeningPort());

    private static final GenericContainer<?> RUSTFS = new GenericContainer<>(
        DockerImageName.parse("rustfs/rustfs:1.0.3"))
        .withExposedPorts(9000)
        .withEnv("RUSTFS_ADDRESS", ":9000")
        .withEnv("RUSTFS_ACCESS_KEY", "t08-media")
        .withEnv("RUSTFS_SECRET_KEY", "t08-media-password")
        .withCreateContainerCmdModifier(command -> command.withUser("0"))
        .withCommand("/data")
        .waitingFor(Wait.forListeningPort());

    static {
        RABBITMQ.start();
        RUSTFS.start();
    }

    @DynamicPropertySource
    static void infrastructure(DynamicPropertyRegistry registry) {
        registry.add("spring.rabbitmq.host", RABBITMQ::getHost);
        registry.add("spring.rabbitmq.port", () -> RABBITMQ.getMappedPort(5672));
        registry.add("spring.rabbitmq.username", () -> "t08");
        registry.add("spring.rabbitmq.password", () -> "t08-rabbit-password");
        registry.add("app.media.storage.endpoint",
            () -> "http://" + RUSTFS.getHost() + ":" + RUSTFS.getMappedPort(9000));
        registry.add("app.media.storage.access-key", () -> "t08-media");
        registry.add("app.media.storage.secret-key", () -> "t08-media-password");
    }

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired OutboxPublisher publisher;
    @Autowired ObjectStorage storage;
    @Autowired MediaInspector inspector;
    @Autowired RabbitTemplate rabbit;
    @Autowired MediaProperties properties;
    private UUID organizer;
    private UUID meeting;

    @BeforeEach
    void fixture() {
        organizer = UUID.randomUUID();
        meeting = UUID.randomUUID();
        String email = "t08-" + organizer + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'T08 organizer','test-only','EMPLOYEE','ACTIVE')
            """, organizer, email, email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'T08 live infrastructure meeting',?,?)
            """, meeting, organizer, organizer);
    }

    private Principal actor() { return () -> organizer.toString(); }

    private static byte[] wav() {
        int samples = 8000;
        byte[] audio = new byte[samples * 2];
        ByteBuffer buffer = ByteBuffer.allocate(44 + audio.length).order(ByteOrder.LITTLE_ENDIAN);
        buffer.put("RIFF".getBytes(StandardCharsets.US_ASCII));
        buffer.putInt(36 + audio.length);
        buffer.put("WAVE".getBytes(StandardCharsets.US_ASCII));
        buffer.put("fmt ".getBytes(StandardCharsets.US_ASCII));
        buffer.putInt(16);
        buffer.putShort((short) 1);
        buffer.putShort((short) 1);
        buffer.putInt(8000);
        buffer.putInt(16000);
        buffer.putShort((short) 2);
        buffer.putShort((short) 16);
        buffer.put("data".getBytes(StandardCharsets.US_ASCII));
        buffer.putInt(audio.length);
        buffer.put(audio);
        return buffer.array();
    }

    private UUID acceptedMediaFixture() {
        UUID media = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                original_filename,content_type,expected_size_bytes,size_bytes,duration_ms,sha256,
                uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'meeting.wav','audio/wav',
                512,512,1000,?,?,CURRENT_TIMESTAMP)
            """, media, meeting, "meetings/" + meeting + "/sources/" + media,
            "meetings/" + meeting + "/pending/" + media, "a".repeat(64), organizer);
        return media;
    }

    private UUID createProcessingJob(UUID media, String key) throws Exception {
        var response = mvc.perform(post("/api/v1/meetings/" + meeting + "/processing-jobs")
            .principal(actor()).header("Idempotency-Key", key)
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"mediaId\":\"" + media + "\"}"))
            .andExpect(status().isAccepted()).andReturn().getResponse();
        assertThat(json.readTree(response.getContentAsString()).path("data").path("status").asText())
            .isEqualTo("PENDING");
        return UUID.fromString(json.readTree(response.getContentAsString()).path("data").path("id").asText());
    }

    private String jobStatus(UUID id) {
        return jdbc.queryForObject("SELECT status FROM processing_jobs WHERE id = ?", String.class, id);
    }

    @Test
    void acceptedSourceIsImmutableAndConfirmedBrokerDeliveryQueuesJob() throws Exception {
        byte[] original = wav();
        var intentResponse = mvc.perform(post("/api/v1/meetings/" + meeting + "/media/uploads")
            .principal(actor()).header("Idempotency-Key", "t08-upload-once")
            .contentType(MediaType.APPLICATION_JSON)
            .content("""
                {"sourceType":"UPLOAD","originalFilename":"meeting.wav",
                 "contentType":"audio/wav","expectedSizeBytes":%d}
                """.formatted(original.length)))
            .andExpect(status().isCreated()).andReturn().getResponse();
        var intent = json.readTree(intentResponse.getContentAsString()).path("data");
        UUID media = UUID.fromString(intent.path("mediaId").asText());
        String presignedPut = intent.path("uploadUrl").asText();
        assertThat(intentResponse.getHeader("Cache-Control")).contains("no-store");

        HttpClient http = HttpClient.newHttpClient();
        HttpRequest put = HttpRequest.newBuilder(URI.create(presignedPut))
            .header("Content-Type", "audio/wav")
            .PUT(HttpRequest.BodyPublishers.ofByteArray(original)).build();
        assertThat(http.send(put, HttpResponse.BodyHandlers.discarding()).statusCode())
            .isBetween(200, 299);

        // Diagnose the complete real storage/ffprobe/conditional-PUT contract
        // independently of API error sanitization before invoking finalization.
        String pendingKey = "meetings/" + meeting + "/pending/" + media;
        assertThat(storage.head(pendingKey).sizeBytes()).isEqualTo(original.length);
        Path fetched = Files.createTempFile("t08-fetched-", ".wav");
        try {
            storage.downloadTo(pendingKey, fetched);
            assertThat(Files.readAllBytes(fetched)).isEqualTo(original);
            var inspection = inspector.inspect(fetched);
            assertThat(inspection.hasAudio()).isTrue();
            assertThat(inspection.detectedFormat()).contains("wav");
            assertThat(inspection.durationMs()).isBetween(900L, 1100L);
            String digest = HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(original));
            String probeKey = "t08/conditional-probe/" + UUID.randomUUID();
            assertThat(storage.putAcceptedIfAbsent(probeKey, fetched, digest)).isTrue();
            assertThat(storage.putAcceptedIfAbsent(probeKey, fetched, digest)).isFalse();
        } finally {
            Files.deleteIfExists(fetched);
        }

        var finalized = mvc.perform(post("/api/v1/meetings/" + meeting + "/media/" + media + "/finalize")
            .principal(actor()))
            .andExpect(status().isOk()).andReturn().getResponse();
        assertThat(json.readTree(finalized.getContentAsString()).path("data").path("status").asText())
            .isEqualTo("AVAILABLE");

        var accessResponse = mvc.perform(post("/api/v1/meetings/" + meeting + "/media/" + media + "/access-url")
            .principal(actor()))
            .andExpect(status().isOk()).andReturn().getResponse();
        assertThat(accessResponse.getHeader("Cache-Control")).contains("no-store");
        URI acceptedUrl = URI.create(json.readTree(accessResponse.getContentAsString())
            .path("data").path("url").asText());
        assertThat(http.send(HttpRequest.newBuilder(acceptedUrl).GET().build(),
            HttpResponse.BodyHandlers.ofByteArray()).body()).isEqualTo(original);

        // The still-valid client PUT grant can overwrite pending, never accepted.
        byte[] replacedPending = Arrays.copyOf(original, original.length);
        replacedPending[replacedPending.length - 1] = 1;
        HttpRequest overwrite = HttpRequest.newBuilder(URI.create(presignedPut))
            .header("Content-Type", "audio/wav")
            .PUT(HttpRequest.BodyPublishers.ofByteArray(replacedPending)).build();
        assertThat(http.send(overwrite, HttpResponse.BodyHandlers.discarding()).statusCode())
            .isBetween(200, 299);
        assertThat(http.send(HttpRequest.newBuilder(acceptedUrl).GET().build(),
            HttpResponse.BodyHandlers.ofByteArray()).body()).isEqualTo(original);

        UUID job = createProcessingJob(media, "t08-job-once");
        assertThat(jobStatus(job)).isEqualTo("PENDING");
        publisher.publishPending();

        assertThat(jobStatus(job)).isEqualTo("QUEUED");
        Message delivery = rabbit.receive(MediaMessagingConfiguration.QUEUE, 5000);
        assertThat(delivery).isNotNull();
        assertThat(delivery.getMessageProperties().getMessageId()).isNotBlank();
        var event = json.readTree(delivery.getBody());
        assertThat(event.path("processingJobId").asText()).isEqualTo(job.toString());
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM outbox_events
            WHERE aggregate_id = ? AND status = 'PUBLISHED'
            """, Integer.class, job)).isEqualTo(1);
    }

    @Test
    void realRabbitReturnsUnroutablePublicationAndJobFailsAfterRetryExhaustion() throws Exception {
        UUID job = createProcessingJob(acceptedMediaFixture(), "t08-unroutable");
        String originalRoutingKey = properties.getOutbox().getRoutingKey();
        int originalAttempts = properties.getOutbox().getMaxAttempts();
        try {
            properties.getOutbox().setRoutingKey("t08.no-route." + UUID.randomUUID());
            properties.getOutbox().setMaxAttempts(1);
            publisher.publishPending();
        } finally {
            properties.getOutbox().setRoutingKey(originalRoutingKey);
            properties.getOutbox().setMaxAttempts(originalAttempts);
        }

        assertThat(jobStatus(job)).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("""
            SELECT status FROM outbox_events WHERE aggregate_id = ?
            """, String.class, job)).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("""
            SELECT error_code FROM processing_jobs WHERE id = ?
            """, String.class, job)).isEqualTo("JOB_DISPATCH_FAILED");
    }
}
