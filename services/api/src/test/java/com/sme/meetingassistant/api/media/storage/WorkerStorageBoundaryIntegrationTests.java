package com.sme.meetingassistant.api.media.storage;

import static org.assertj.core.api.Assertions.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.S3Exception;

/** Synthetic writes only to the explicitly isolated Python-owned RustFS fixture. */
@EnabledIfEnvironmentVariable(named="E2E03_STORAGE_FIXTURE",matches="true")
class WorkerStorageBoundaryIntegrationTests {
    String env(String name) { return java.util.Objects.requireNonNull(System.getenv(name),name); }
    S3Client client(String role) {
        String endpoint=env("E2E03_STORAGE_ENDPOINT");
        assertThat(URI.create(endpoint).getHost()).isEqualTo("localhost");
        return S3Client.builder().endpointOverride(URI.create(endpoint)).region(Region.US_EAST_1).forcePathStyle(true)
            .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(env("E2E03_"+role+"_KEY"),env("E2E03_STORAGE_SECRET"))))
            .httpClientBuilder(S3ObjectStorageAdapter.verifiedHttps(endpoint,Path.of(env("E2E03_STORAGE_CA"))))
            .overrideConfiguration(c->c.apiCallTimeout(java.time.Duration.ofSeconds(15))).build();
    }
    void rejected(int status,org.assertj.core.api.ThrowableAssert.ThrowingCallable request) {
        assertThatThrownBy(request).isInstanceOfSatisfying(S3Exception.class,e->assertThat(e.statusCode()).isEqualTo(status));
    }
    @Test void javaSdkConditionalConflictAndDenialLeaveReusableConnectionAndOriginalBytes() {
        String bucket=env("E2E03_STORAGE_BUCKET"); assertThat(bucket).isEqualTo("transport-fixture");
        String key="processing/"+UUID.randomUUID()+"/transcription/results/"+UUID.randomUUID()+".json";
        String source="meetings/fixture/sources/audio";
        byte[] original="synthetic immutable Java result".getBytes(StandardCharsets.UTF_8);
        try(var worker=client("WORKER");var core=client("CORE")) {
            worker.putObject(b->b.bucket(bucket).key(key).ifNoneMatch("*"),RequestBody.fromBytes(original));
            rejected(412,()->worker.putObject(b->b.bucket(bucket).key(key).ifNoneMatch("*"),RequestBody.fromString("conflict")));
            rejected(403,()->worker.putObject(b->b.bucket(bucket).key(key),RequestBody.fromString("unconditional")));
            assertThat(worker.getObjectAsBytes(b->b.bucket(bucket).key(key)).asByteArray()).isEqualTo(original);
            rejected(403,()->worker.putObject(b->b.bucket(bucket).key(source).ifNoneMatch("*"),RequestBody.fromString("source overwrite")));
            rejected(403,()->worker.deleteObject(b->b.bucket(bucket).key(key)));
            rejected(403,()->worker.deleteObject(b->b.bucket(bucket).key(source)));
            assertThat(core.getObjectAsBytes(b->b.bucket(bucket).key(key)).asByteArray()).isEqualTo(original);
            assertThat(core.getObjectAsBytes(b->b.bucket(bucket).key(source)).asUtf8String()).isEqualTo("accepted audio");
        }
    }
}
