package com.sme.meetingassistant.api.meetingexport;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.storage.S3ObjectStorageAdapter;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.Principal;
import java.time.Duration;
import java.util.UUID;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.text.PDFTextStripper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * DE-13 acceptance: real canonical Meeting/Transcript/Summary/Decision/Action Item
 * persistence -> actual MinutesAssembler -> Spring HTTP admission -> PostgreSQL
 * durable worker -> both renderers -> real private RustFS/S3 objects ->
 * authorized status/capability -> stale and revocation.
 * The public API signs HTTPS URLs, while a separate test-local signer verifies
 * actual HTTP downloads from the isolated RustFS container. This does not
 * establish public HTTPS transport or Web browser acceptance.
 * No mocked Minutes assembly, worker, renderer, or object storage.
 */
@ActiveProfiles("test")
@SpringBootTest(properties={
    "app.media.outbox.enabled=false",
    "app.exports.worker.enabled=true",
    "app.exports.worker.poll-delay-ms=3600000",
    "app.exports.public-admission-enabled=true"
})
@AutoConfigureMockMvc
@Import({PostgresTestConfiguration.class, DashboardExportModuleAcceptanceTests.StorageConfig.class})
class DashboardExportModuleAcceptanceTests {
    @TestConfiguration(proxyBeanMethods=false)
    static class StorageConfig {
        @Bean(destroyMethod = "close")
        RustfsFixture mi06Rustfs() {
            return new RustfsFixture();
        }

        @Bean
        @Primary
        S3ObjectStorageAdapter mi06PublicStorage(RustfsFixture fixture) {
            return new S3ObjectStorageAdapter(fixture.properties(true));
        }

        @Bean
        S3ObjectStorageAdapter mi06LocalStorage(RustfsFixture fixture) {
            return new S3ObjectStorageAdapter(fixture.properties(false));
        }
    }

    /** Uses the same pinned storage image as ExportS3StorageIntegrationTests. */
    static final class RustfsFixture implements AutoCloseable {
        private static final String ACCESS = "mi06-test-access";
        private static final String SECRET = "mi06-isolated-test-secret-value";
        private static final String BUCKET = "mi06-private-exports";
        private final GenericContainer<?> container = new GenericContainer<>(
                DockerImageName.parse("rustfs/rustfs:1.0.3"))
                .withEnv("RUSTFS_ACCESS_KEY", ACCESS)
                .withEnv("RUSTFS_SECRET_KEY", SECRET)
                .withEnv("RUSTFS_ADDRESS", ":9000")
                .withEnv("RUSTFS_CONSOLE_ENABLE", "false")
                .withExposedPorts(9000).withCommand("/data")
                .waitingFor(Wait.forHttp("/health/ready").forPort(9000).forStatusCode(200))
                .withStartupTimeout(Duration.ofMinutes(3));
        private final String endpoint;

        RustfsFixture() {
            container.start();
            try {
                endpoint = "http://" + container.getHost() + ":" + container.getMappedPort(9000);
                try (S3Client admin = S3Client.builder().endpointOverride(URI.create(endpoint))
                        .region(Region.US_EAST_1)
                        .serviceConfiguration(S3Configuration.builder()
                                .pathStyleAccessEnabled(true).build())
                        .credentialsProvider(StaticCredentialsProvider.create(
                                AwsBasicCredentials.create(ACCESS, SECRET))).build()) {
                    admin.createBucket(CreateBucketRequest.builder().bucket(BUCKET).build());
                }
            } catch (RuntimeException | Error failure) {
                container.stop();
                throw failure;
            }
        }

        MediaProperties properties(boolean publicSigner) {
            MediaProperties config = new MediaProperties();
            var bucket = config.getStorage();
            bucket.setEndpoint(endpoint);
            bucket.setRegion("us-east-1");
            bucket.setBucket(BUCKET);
            bucket.setAccessKey(ACCESS);
            bucket.setSecretKey(SECRET);
            bucket.setPathStyleAccess(true);
            if (publicSigner) {
                bucket.setPublicDownloadEndpoint("https://downloads.example.invalid");
            }
            return config;
        }

        URI unsignedArtifact(ExportRecord record) {
            return URI.create(endpoint + "/" + BUCKET + "/" + record.objectKey());
        }

        @Override
        public void close() {
            container.stop();
        }
    }

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired MeetingExportRepository exports;
    @Autowired ExportJobProcessor worker;
    @Autowired ExportGenerationStateMachine state;
    @Autowired S3ExportArtifactStore storage;
    @Autowired RustfsFixture rustfs;
    @Autowired @Qualifier("mi06LocalStorage") S3ObjectStorageAdapter localStorage;

    @BeforeEach
    void clearUnclaimedFixtures() {
        for (int i = 0; i < 100; i++) {
            var claim = state.claimNext(30);
            if (claim.isEmpty()) break;
            assertThat(state.fail(claim.get().id(), claim.get().claimToken(),
                    "DE13_FIXTURE_CLEANUP")).isTrue();
        }
    }

    @Test
    void canonicalCrossModuleFlowRendersBothFormatsAndEnforcesFreshnessAndRevocation()
            throws Exception {
        UUID owner = user("EMPLOYEE"), member = user("EMPLOYEE"),
                outsider = user("ADMINISTRATOR");
        UUID meeting = meeting(owner);
        participant(meeting, member);
        Source processing = transcript(meeting, owner);
        summary(meeting, processing, "Tóm tắt đã được rà soát");
        confirmedDecision(meeting, owner, "Chốt triển khai giải pháp A");
        proposedDecision(meeting, owner, "Đề xuất chưa duyệt");
        UUID action = action(meeting, owner, "Chuẩn bị tài liệu kiểm thử");

        JsonNode minutes = data(mvc.perform(get("/api/v1/meetings/{id}/minutes", meeting)
                .principal(as(owner))).andExpect(status().isOk()).andReturn());
        assertThat(minutes.path("completeness").asText()).isEqualTo("COMPLETE");
        assertThat(minutes.path("summary").path("content").asText())
                .isEqualTo("Tóm tắt đã được rà soát");
        assertThat(minutes.path("confirmedDecisions").size()).isEqualTo(1);
        assertThat(minutes.path("officialActionItems").size()).isEqualTo(1);
        assertThat(minutes.toString()).doesNotContain("Đề xuất chưa duyệt");
        String originalFingerprint = minutes.path("sourceFingerprint").asText();
        assertThat(originalFingerprint).matches("[0-9a-f]{64}");

        JsonNode dashboard = data(mvc.perform(get("/api/v1/dashboard/me")
                .principal(as(owner))).andExpect(status().isOk()).andReturn());
        assertThat(dashboard.path("assignedActionItems").path("open").asLong())
                .isGreaterThanOrEqualTo(1);

        UUID markdown = requestExport(meeting, owner, "MARKDOWN", "de13-accept-md");
        UUID pdf = requestExport(meeting, owner, "PDF", "de13-accept-pdf");
        assertThat(worker.processNext()).isTrue();
        assertThat(worker.processNext()).isTrue();
        ExportRecord md = exports.require(markdown);
        ExportRecord pdfArtifact = exports.require(pdf);
        assertThat(md.status()).isEqualTo(ExportStatus.READY);
        assertThat(pdfArtifact.status()).isEqualTo(ExportStatus.READY);
        assertThat(md.sourceFingerprint()).isEqualTo(originalFingerprint);
        assertThat(pdfArtifact.sourceFingerprint()).isEqualTo(originalFingerprint);
        byte[] downloadedMarkdown = downloadFromIsolatedStorage(md);
        byte[] downloadedPdf = downloadFromIsolatedStorage(pdfArtifact);
        assertThat(new String(downloadedMarkdown, StandardCharsets.UTF_8))
                .contains("Tóm tắt đã được rà soát", "Chốt triển khai giải pháp A",
                        "Chuẩn bị tài liệu kiểm thử")
                .doesNotContain("Đề xuất chưa duyệt");
        try (var doc = Loader.loadPDF(downloadedPdf)) {
            String rendered = new PDFTextStripper().getText(doc);
            assertThat(rendered).contains("Tóm tắt đã được rà soát",
                    "Chốt triển khai giải pháp A", "Chuẩn bị tài liệu kiểm thử");
            assertThat(rendered).doesNotContain("Đề xuất chưa duyệt");
        }

        JsonNode current = data(mvc.perform(get("/api/v1/exports/{id}", markdown)
                .principal(as(member))).andExpect(status().isOk()).andReturn());
        assertThat(current.path("freshness").asText()).isEqualTo("CURRENT");
        assertThat(current.toString()).doesNotContain("objectKey",
                "artifactSha256", "claimToken");
        JsonNode issued = data(mvc.perform(post("/api/v1/exports/{id}/access-url", markdown)
                .principal(as(member))).andExpect(status().isOk()).andReturn());
        assertPublicCapability(issued, md);
        JsonNode issuedPdf = data(mvc.perform(post("/api/v1/exports/{id}/access-url", pdf)
                .principal(as(member))).andExpect(status().isOk()).andReturn());
        assertPublicCapability(issuedPdf, pdfArtifact);

        mvc.perform(get("/api/v1/exports/{id}", markdown)
                .principal(as(outsider))).andExpect(status().isNotFound());
        mvc.perform(post("/api/v1/exports/{id}/access-url", markdown)
                .principal(as(outsider))).andExpect(status().isNotFound());

        // Canonical Action Item revision rotates the source fingerprint but
        // cannot rewrite already-persisted PDF/Markdown objects.
        jdbc.update("UPDATE action_items SET title=?,version=version+1 WHERE id=?",
                "Chuẩn bị tài liệu phiên bản hai", action);
        JsonNode stale = data(mvc.perform(get("/api/v1/exports/{id}", markdown)
                .principal(as(member))).andExpect(status().isOk()).andReturn());
        assertThat(stale.path("freshness").asText()).isEqualTo("STALE");
        assertThat(exports.require(markdown).sourceFingerprint())
                .isEqualTo(originalFingerprint);
        assertThat(exports.require(pdf).status()).isEqualTo(ExportStatus.READY);
        assertThat(storage.readVerified(md.objectKey(), md.artifactSha256(),
                32 * 1024 * 1024)).isEqualTo(downloadedMarkdown);
        assertThat(storage.readVerified(pdfArtifact.objectKey(), pdfArtifact.artifactSha256(),
                32 * 1024 * 1024)).isEqualTo(downloadedPdf);

        jdbc.update("UPDATE meeting_participants SET removed_at=clock_timestamp() "
                + "WHERE meeting_id=? AND user_id=? AND removed_at IS NULL", meeting, member);
        mvc.perform(post("/api/v1/exports/{id}/access-url", markdown)
                .principal(as(member))).andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/meetings/{id}/minutes", meeting)
                .principal(as(member))).andExpect(status().isNotFound());
        assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM audit_events WHERE entity_id=? "
                + "AND action_code='EXPORT_DOWNLOAD_CAPABILITY_ISSUED'",
                Long.class, markdown)).isEqualTo(1L);
    }

    @Test
    void missingAiContentIsVisibleButCannotBecomeAnOfficialExport() throws Exception {
        UUID owner = user("EMPLOYEE"), external = user("EMPLOYEE");
        UUID meeting = meeting(owner);
        JsonNode minutes = data(mvc.perform(get("/api/v1/meetings/{id}/minutes", meeting)
                .principal(as(owner))).andExpect(status().isOk()).andReturn());
        assertThat(minutes.path("completeness").asText()).isEqualTo("PARTIAL");
        assertThat(minutes.path("warnings").toString())
                .contains("SUMMARY_NOT_AVAILABLE", "TRANSCRIPT_NOT_AVAILABLE");
        mvc.perform(post("/api/v1/meetings/{id}/exports", meeting)
                .principal(as(owner)).header("Idempotency-Key", "de13-incomplete")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"format\":\"PDF\"}"))
                .andExpect(status().isConflict());
        mvc.perform(post("/api/v1/meetings/{id}/exports", meeting)
                .principal(as(external)).header("Idempotency-Key", "de13-outsider")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"format\":\"PDF\"}"))
                .andExpect(status().isNotFound());
        assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM meeting_exports WHERE meeting_id=?",
                Long.class, meeting)).isZero();
    }

    private static void assertPublicCapability(JsonNode capability, ExportRecord record) {
        URI url = URI.create(capability.path("accessUrl").asText());
        assertThat(url.getScheme()).isEqualTo("https");
        assertThat(url.getHost()).isEqualTo("downloads.example.invalid");
        assertThat(url.getRawQuery() != null && url.getRawQuery().contains("X-Amz-Signature="))
                .isTrue();
        assertThat(capability.path("exportId").asText()).isEqualTo(record.id().toString());
        assertThat(capability.path("filename").asText()).isEqualTo(
                "meeting-minutes-" + record.id() + "." + record.format().extension());
        assertThat(capability.path("freshness").asText()).isEqualTo("CURRENT");
    }

    /**
     * Exercise real signed GETs without rewriting or following the public API
     * capability to an untrusted HTTP origin. The test-local storage adapter
     * signs the same READY record for this isolated HTTP-only container.
     */
    private byte[] downloadFromIsolatedStorage(ExportRecord record) throws Exception {
        String signed = new S3ExportArtifactStore(localStorage)
                .createVerifiedCapability(record, Duration.ofSeconds(60));
        try (HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10)).build()) {
            var unsigned = client.send(HttpRequest.newBuilder(rustfs.unsignedArtifact(record))
                    .timeout(Duration.ofSeconds(20)).GET().build(),
                    HttpResponse.BodyHandlers.discarding());
            assertThat(unsigned.statusCode()).isEqualTo(403);
            var response = client.send(HttpRequest.newBuilder(URI.create(signed))
                    .timeout(Duration.ofSeconds(20)).GET().build(),
                    HttpResponse.BodyHandlers.ofByteArray());
            assertThat(response.statusCode()).isEqualTo(200);
            assertThat((long) response.body().length).isEqualTo(record.artifactSizeBytes());
            assertThat(ExportSnapshotCodec.sha256(response.body()))
                    .isEqualTo(record.artifactSha256());
            assertThat(response.headers().firstValue("Content-Type").orElse(""))
                    .isEqualTo(record.format() == ExportFormat.PDF
                            ? "application/pdf" : "text/markdown; charset=UTF-8");
            assertThat(response.headers().firstValue("Content-Disposition").orElse(""))
                    .isEqualTo("attachment; filename=\"meeting-minutes-" + record.id()
                            + "." + record.format().extension() + "\"");
            assertThat(response.headers().firstValue("Cache-Control").orElse(""))
                    .contains("private", "no-store");
            return response.body();
        }
    }

    private UUID requestExport(UUID meeting, UUID owner, String format, String key)
            throws Exception {
        MvcResult response = mvc.perform(post("/api/v1/meetings/{id}/exports", meeting)
                .principal(as(owner)).header("Idempotency-Key", key)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"format\":\"" + format + "\"}"))
                .andExpect(status().isAccepted()).andReturn();
        UUID id = UUID.fromString(data(response).path("exportId").asText());
        assertThat(exports.require(id).status()).isEqualTo(ExportStatus.PENDING);
        return id;
    }

    private JsonNode data(MvcResult result) throws Exception {
        JsonNode body = json.readTree(result.getResponse().getContentAsString());
        assertThat(body.path("success").asBoolean()).isTrue();
        assertThat(body.path("meta").path("requestId").asText()).isNotBlank();
        return body.path("data");
    }

    private static Principal as(UUID id) { return () -> id.toString(); }

    private UUID user(String role) {
        UUID id = UUID.randomUUID();
        String email = "de13-" + id + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,
                              global_role,account_status)
            VALUES (?,?,?,'DE13 integration','test-only',?,'ACTIVE')
            """, id, email, email, role);
        return id;
    }

    private UUID meeting(UUID owner) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id,status)
            VALUES (?,'DE13 kết nối các module',?,?,'DRAFT')
            """, id, owner, owner);
        return id;
    }

    private void participant(UUID meeting, UUID member) {
        jdbc.update("INSERT INTO meeting_participants(id,meeting_id,user_id) "
                + "VALUES (?,?,?)", UUID.randomUUID(), meeting, member);
    }

    private UUID action(UUID meeting, UUID actor, String title) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO action_items(id,meeting_id,title,status,assignee_user_id,
                                     source_type,created_by_user_id)
            VALUES (?,?,?,'OPEN',?,'MANUAL',?)
            """, id, meeting, title, actor, actor);
        return id;
    }

    private void confirmedDecision(UUID meeting, UUID actor, String content) {
        jdbc.update("""
            INSERT INTO meeting_decisions(id,meeting_id,content,status,source_type,
                     created_by_user_id,confirmed_by_user_id,confirmed_at)
            VALUES (?,?,?,'CONFIRMED','MANUAL',?,?,CURRENT_TIMESTAMP)
            """, UUID.randomUUID(), meeting, content, actor, actor);
    }

    private void proposedDecision(UUID meeting, UUID actor, String content) {
        jdbc.update("""
            INSERT INTO meeting_decisions(id,meeting_id,content,status,source_type,created_by_user_id)
            VALUES (?,?,?,'PROPOSED','MANUAL',?)
            """, UUID.randomUUID(), meeting, content, actor);
    }

    private record Source(UUID mediaId, UUID jobId, UUID transcriptId) { }

    private Source transcript(UUID meeting, UUID actor) {
        UUID media = UUID.randomUUID(), job = UUID.randomUUID(), transcript = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                  content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,10000,?,CURRENT_TIMESTAMP)
            """, media, meeting, "de13/ready/" + media, "de13/pending/" + media, actor);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status)
            VALUES (?,?,?,?,'COMPLETED')
            """, job, meeting, media, actor);
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,
                  version_number,language_code,status,is_current,content_revision)
            VALUES (?,?,?,?,1,'vi','READY',TRUE,0)
            """, transcript, meeting, media, job);
        return new Source(media, job, transcript);
    }

    private void summary(UUID meeting, Source source, String content) {
        UUID stage=UUID.randomUUID(), snapshot=UUID.randomUUID(), receipt=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'GENERATING_SUMMARY',1,'SUCCEEDED')
            """, stage, source.jobId());
        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(
              id,meeting_id,source_media_id,processing_job_id,transcript_id,content_revision,
              sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,0,?,?,100)
            """, snapshot, meeting, source.mediaId(), source.jobId(), source.transcriptId(),
                "a".repeat(64), "processing/" + source.jobId()
                    + "/intelligence/source/" + snapshot + ".json");
        jdbc.update("""
            INSERT INTO meeting_intelligence_result_receipts(
              id,meeting_id,processing_job_id,stage_run_id,result_type,source_snapshot_id,
              transcript_id,content_revision,artifact_sha256,artifact_object_key,artifact_size_bytes)
            VALUES (?,?,?,?,'SUMMARY',?,?,0,?,?,200)
            """, receipt, meeting, source.jobId(), stage, snapshot, source.transcriptId(),
                "b".repeat(64), "processing/" + source.jobId()
                    + "/intelligence/results/" + stage + ".json");
        jdbc.update("""
            INSERT INTO meeting_summary_versions(id,meeting_id,version_number,content,source_type,
              processing_job_id,result_receipt_id,transcript_id,content_revision,quality_status,is_current)
            VALUES (?,?,1,?,'AI_GENERATED',?,?,?,0,'READY',TRUE)
            """, UUID.randomUUID(), meeting, content, source.jobId(), receipt,
                source.transcriptId());
    }
}
