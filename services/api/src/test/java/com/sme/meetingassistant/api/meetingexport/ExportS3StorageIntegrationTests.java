package com.sme.meetingassistant.api.meetingexport;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.storage.S3ObjectStorageAdapter;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

/**
 * Actual AWS SDK/S3-compatible RustFS boundary; no mocked S3 semantics.
 * Isolated private bucket, conditional immutable writes, signed GET headers.
 * In tests the ephemeral Docker endpoint is HTTP; the HTTP API rejects
 * insecure presigned URLs, while deployment must provide public HTTPS origin.
 */
class ExportS3StorageIntegrationTests {
    private static final String ACCESS="de10-storage-admin";
    private static final String SECRET="de10-private-test-secret-value";
    private static final String BUCKET="de10-private-exports";
    private static final GenericContainer<?> RUSTFS=new GenericContainer<>(
            DockerImageName.parse("rustfs/rustfs:1.0.3"))
            .withEnv("RUSTFS_ACCESS_KEY", ACCESS)
            .withEnv("RUSTFS_SECRET_KEY", SECRET)
            .withEnv("RUSTFS_ADDRESS", ":9000")
            .withEnv("RUSTFS_CONSOLE_ENABLE", "false")
            .withExposedPorts(9000).withCommand("/data")
            .waitingFor(Wait.forHttp("/health/ready")
                    .forPort(9000).forStatusCode(200))
            .withStartupTimeout(Duration.ofMinutes(3));

    private static S3Client admin;
    private static S3ObjectStorageAdapter storage;
    private static S3ExportArtifactStore exports;
    private static String endpoint;

    @BeforeAll
    static void start() {
        RUSTFS.start();
        endpoint="http://"+RUSTFS.getHost()+":"+RUSTFS.getMappedPort(9000);
        admin=S3Client.builder().endpointOverride(URI.create(endpoint))
                .region(Region.US_EAST_1)
                .serviceConfiguration(software.amazon.awssdk.services.s3.S3Configuration
                        .builder().pathStyleAccessEnabled(true).build())
                .credentialsProvider(StaticCredentialsProvider.create(
                        AwsBasicCredentials.create(ACCESS, SECRET))).build();
        admin.createBucket(CreateBucketRequest.builder().bucket(BUCKET).build());
        MediaProperties config=new MediaProperties();
        var bucket=config.getStorage();
        bucket.setEndpoint(endpoint);
        bucket.setRegion("us-east-1");
        bucket.setBucket(BUCKET);
        bucket.setAccessKey(ACCESS);
        bucket.setSecretKey(SECRET);
        bucket.setPathStyleAccess(true);
        storage=new S3ObjectStorageAdapter(config);
        exports=new S3ExportArtifactStore(storage);
    }

    @AfterAll
    static void stop() {
        if(admin!=null)admin.close();
        RUSTFS.stop();
    }

    @Test
    void privateArtifactIsImmutableChecksumVerifiedAndPresignedWithSafeHeaders()
            throws Exception {
        UUID exportId=UUID.randomUUID();
        byte[] content="PDF synthetic binary bytes for DE10 signed GET".getBytes(
                StandardCharsets.UTF_8);
        String digest=ExportSnapshotCodec.sha256(content);
        String key=ExportDigests.artifactKey(exportId,ExportFormat.PDF,digest);
        exports.putVerified(key,content,"application/pdf",digest);
        assertThat(storage.putImmutableBytesIfAbsent(key,content,"application/pdf",digest))
                .isFalse();
        ExportRecord ready=ready(exportId,ExportFormat.PDF,digest,content.length);
        String signed=exports.createVerifiedCapability(ready,Duration.ofSeconds(45));
        URI signedUri=URI.create(signed);
        assertThat(signedUri.getScheme()).isEqualTo("http");
        assertThat(signedUri.getRawQuery()).contains("X-Amz-Signature","X-Amz-Expires=45");
        try(HttpClient client=HttpClient.newHttpClient()) {
            HttpResponse<byte[]> denied=client.send(HttpRequest.newBuilder()
                    .uri(URI.create(endpoint+"/"+BUCKET+"/"+key)).GET().build(),
                    HttpResponse.BodyHandlers.ofByteArray());
            assertThat(denied.statusCode()).isEqualTo(403);
            HttpResponse<byte[]> valid=client.send(HttpRequest.newBuilder()
                    .uri(signedUri).GET().build(),
                    HttpResponse.BodyHandlers.ofByteArray());
            assertThat(valid.statusCode()).isEqualTo(200);
            assertThat(valid.body()).isEqualTo(content);
            assertThat(valid.headers().firstValue("Content-Disposition").orElse(""))
                    .isEqualTo("attachment; filename=\"meeting-minutes-"+exportId+".pdf\"");
            assertThat(valid.headers().firstValue("Content-Type").orElse(""))
                    .isEqualTo("application/pdf");
            assertThat(valid.headers().firstValue("Cache-Control").orElse(""))
                    .contains("private","no-store");
        }
    }

    @Test
    void sourceTamperAndDeletedObjectCannotGenerateNewCapability() {
        UUID id=UUID.randomUUID();
        byte[] original="# Cần xác nhận".getBytes(StandardCharsets.UTF_8);
        String digest=ExportSnapshotCodec.sha256(original);
        String key=ExportDigests.artifactKey(id,ExportFormat.MARKDOWN,digest);
        exports.putVerified(key,original,"text/markdown; charset=UTF-8",digest);
        ExportRecord ready=ready(id,ExportFormat.MARKDOWN,digest,original.length);
        assertThat(exports.createVerifiedCapability(ready,Duration.ofSeconds(60)))
                .contains("X-Amz-Signature");
        // Simulate privileged out-of-band corruption; the checksum guard detects it.
        byte[] replacement="changed content".getBytes(StandardCharsets.UTF_8);
        admin.putObject(PutObjectRequest.builder().bucket(BUCKET).key(key)
                .contentType("text/markdown; charset=UTF-8").build(),
                RequestBody.fromBytes(replacement));
        assertThatThrownBy(()->exports.createVerifiedCapability(
                ready,Duration.ofSeconds(60)))
                .isInstanceOf(ExportArtifactStore.IntegrityFailure.class);
        admin.deleteObject(b->b.bucket(BUCKET).key(key));
        assertThatThrownBy(()->exports.createVerifiedCapability(
                ready,Duration.ofSeconds(60)))
                .isInstanceOf(ExportArtifactStore.StorageFailure.class);
    }

    @Test
    void mismatchedContentTypeAndInvalidRecordMetadataAreRejected() {
        UUID id=UUID.randomUUID();
        byte[] data="example".getBytes(StandardCharsets.UTF_8);
        String sha=ExportSnapshotCodec.sha256(data);
        String key=ExportDigests.artifactKey(id,ExportFormat.PDF,sha);
        exports.putVerified(key,data,"application/pdf",sha);
        ExportRecord ready=ready(id,ExportFormat.PDF,sha,data.length);
        assertThatThrownBy(()->exports.createVerifiedCapability(
                ready,Duration.ofMinutes(6)))
                .isInstanceOf(RuntimeException.class);
        admin.putObject(PutObjectRequest.builder().bucket(BUCKET).key(key)
                .contentType("text/plain").build(),RequestBody.fromBytes(data));
        assertThatThrownBy(()->exports.createVerifiedCapability(
                ready,Duration.ofSeconds(60)))
                .isInstanceOf(ExportArtifactStore.IntegrityFailure.class);
    }

    @Test
    void publicHttpsSigningOriginMustBeConfiguredExplicitly() {
        MediaProperties config=new MediaProperties();
        var c=config.getStorage();
        c.setEndpoint(endpoint);
        c.setPublicDownloadEndpoint("https://downloads.example.invalid");
        c.setRegion("us-east-1");
        c.setBucket(BUCKET);
        c.setAccessKey(ACCESS);
        c.setSecretKey(SECRET);
        c.setPathStyleAccess(true);
        S3ObjectStorageAdapter signer=new S3ObjectStorageAdapter(config);
        String key="exports/"+UUID.randomUUID()+"/artifacts/"+"a".repeat(64)+".pdf";
        String url=signer.createExportDownloadCapability(key,Duration.ofSeconds(60),
                "meeting-minutes-"+UUID.randomUUID()+".pdf","application/pdf");
        assertThat(url).startsWith("https://downloads.example.invalid");
        assertThat(url).contains("X-Amz-Signature");
        c.setPublicDownloadEndpoint("http://untrusted.example.invalid");
        assertThatThrownBy(()->new S3ObjectStorageAdapter(config))
                .isInstanceOf(IllegalStateException.class);
    }

    private static ExportRecord ready(UUID id,ExportFormat fmt,String sha,long size) {
        OffsetDateTime now=OffsetDateTime.now(ZoneOffset.UTC);
        return new ExportRecord(id,UUID.randomUUID(),fmt,ExportStatus.READY,
                UUID.randomUUID(),now,now,
                ExportDigests.artifactKey(id,fmt,sha),"a".repeat(64),null,
                1,null,null,"exports/"+id+"/snapshots/"+"a".repeat(64)+".json",
                "de10-test-v1",sha,size,3);
    }
}
