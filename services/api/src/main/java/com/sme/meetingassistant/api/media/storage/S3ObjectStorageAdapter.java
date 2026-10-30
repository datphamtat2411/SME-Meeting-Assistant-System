package com.sme.meetingassistant.api.media.storage;

import com.sme.meetingassistant.api.media.MediaProperties;
import java.net.URI;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import software.amazon.awssdk.core.sync.RequestBody;
import jakarta.annotation.PreDestroy;
import org.springframework.stereotype.Component;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.sync.ResponseTransformer;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import software.amazon.awssdk.services.s3.model.HeadBucketRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.model.S3Exception;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.GetObjectPresignRequest;
import software.amazon.awssdk.services.s3.presigner.model.PutObjectPresignRequest;

@Component
public class S3ObjectStorageAdapter implements ObjectStorage {
    private final MediaProperties.Storage properties;
    private final S3Client client;
    private final S3Presigner presigner;

    public S3ObjectStorageAdapter(MediaProperties properties) {
        this.properties = properties.getStorage();
        var endpoint = URI.create(this.properties.getEndpoint());
        boolean hasAccessKey = this.properties.getAccessKey() != null && !this.properties.getAccessKey().isBlank();
        boolean hasSecretKey = this.properties.getSecretKey() != null && !this.properties.getSecretKey().isBlank();
        if (hasAccessKey != hasSecretKey) throw new IllegalStateException("Both S3 credentials must be configured together.");
        var serviceConfig = S3Configuration.builder()
            .pathStyleAccessEnabled(this.properties.isPathStyleAccess()).build();
        this.client = S3Client.builder().endpointOverride(endpoint).region(Region.of(this.properties.getRegion()))
            .credentialsProvider(credentialsProvider()).serviceConfiguration(serviceConfig).build();
        this.presigner = S3Presigner.builder().endpointOverride(endpoint).region(Region.of(this.properties.getRegion()))
            .credentialsProvider(credentialsProvider()).serviceConfiguration(serviceConfig).build();
    }

    @Override
    public String createUploadCapability(String objectKey, String contentType, long contentLength, Duration ttl) {
        ensureBucketExists();
        var request = PutObjectRequest.builder().bucket(this.properties.getBucket()).key(objectKey)
            .contentType(contentType).contentLength(contentLength).build();
        return this.presigner.presignPutObject(PutObjectPresignRequest.builder().signatureDuration(ttl)
            .putObjectRequest(request).build()).url().toExternalForm();
    }

    @Override
    public String createDownloadCapability(String objectKey, Duration ttl) {
        var request = GetObjectRequest.builder().bucket(this.properties.getBucket()).key(objectKey).build();
        return this.presigner.presignGetObject(GetObjectPresignRequest.builder().signatureDuration(ttl)
            .getObjectRequest(request).build()).url().toExternalForm();
    }

    @Override
    public StoredObject head(String objectKey) {
        var result = this.client.headObject(HeadObjectRequest.builder().bucket(this.properties.getBucket())
            .key(objectKey).build());
        return new StoredObject(result.contentLength(), result.contentType(), result.eTag());
    }

    @Override
    public void downloadTo(String objectKey, Path destination) {
        this.client.getObject(GetObjectRequest.builder().bucket(this.properties.getBucket()).key(objectKey).build(),
            ResponseTransformer.toFile(destination));
    }

    @Override
    public boolean putAcceptedIfAbsent(String objectKey, Path validatedFile, String sha256) {
        var request = PutObjectRequest.builder()
            .bucket(this.properties.getBucket()).key(objectKey)
            .ifNoneMatch("*")
            .metadata(Map.of("sha256", sha256))
            .build();
        try {
            this.client.putObject(request, RequestBody.fromFile(validatedFile));
            return true;
        } catch (S3Exception exception) {
            if (exception.statusCode() == 412) return false;
            // A 409 is an indeterminate concurrent/conditional write conflict, not proof
            // that the target was accepted. The caller retries after checking HEAD.
            throw exception;
        }
    }

    @Override
    public void delete(String objectKey) {
        this.client.deleteObject(DeleteObjectRequest.builder().bucket(this.properties.getBucket()).key(objectKey).build());
    }

    @PreDestroy
    void closeClients() {
        this.presigner.close();
        this.client.close();
    }

    private software.amazon.awssdk.auth.credentials.AwsCredentialsProvider credentialsProvider() {
        if (this.properties.getAccessKey() == null || this.properties.getAccessKey().isBlank()) {
            return DefaultCredentialsProvider.create();
        }
        return StaticCredentialsProvider.create(AwsBasicCredentials.create(
            this.properties.getAccessKey(), this.properties.getSecretKey()));
    }

    private void ensureBucketExists() {
        try {
            this.client.headBucket(HeadBucketRequest.builder().bucket(this.properties.getBucket()).build());
        } catch (S3Exception exception) {
            if (!this.properties.isCreateBucketIfMissing() || exception.statusCode() != 404) {
                throw exception;
            }
            try {
                this.client.createBucket(CreateBucketRequest.builder().bucket(this.properties.getBucket()).build());
            } catch (S3Exception createException) {
                // Concurrent first uploads may both observe the absent bucket.
                if (createException.statusCode() != 409) {
                    throw createException;
                }
            }
        }
    }

}
