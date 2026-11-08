package com.sme.meetingassistant.api.media.storage;

import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.transport.PemTls;
import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
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
import software.amazon.awssdk.services.s3.model.ListObjectsV2Request;
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
    private final S3Presigner exportPresigner;

    public S3ObjectStorageAdapter(MediaProperties properties) {
        this.properties = properties.getStorage();
        var endpoint = URI.create(this.properties.getEndpoint());
        boolean hasAccessKey = this.properties.getAccessKey() != null && !this.properties.getAccessKey().isBlank();
        boolean hasSecretKey = this.properties.getSecretKey() != null && !this.properties.getSecretKey().isBlank();
        if (hasAccessKey != hasSecretKey) throw new IllegalStateException("Both S3 credentials must be configured together.");
        var serviceConfig = S3Configuration.builder()
            .pathStyleAccessEnabled(this.properties.isPathStyleAccess()).build();
        var builder = S3Client.builder().endpointOverride(endpoint).region(Region.of(this.properties.getRegion()))
            .credentialsProvider(credentialsProvider()).serviceConfiguration(serviceConfig);
        if (this.properties.getCaFile() != null && !this.properties.getCaFile().isBlank()) {
            builder.httpClientBuilder(verifiedHttps(this.properties.getEndpoint(), Path.of(this.properties.getCaFile())));
        }
        this.client = builder.build();
        this.presigner = S3Presigner.builder().endpointOverride(endpoint).region(Region.of(this.properties.getRegion()))
            .credentialsProvider(credentialsProvider()).serviceConfiguration(serviceConfig).build();
        String publicEndpoint = this.properties.getPublicDownloadEndpoint();
        if (publicEndpoint == null || publicEndpoint.isBlank()) {
            this.exportPresigner = this.presigner;
        } else {
            URI external = URI.create(publicEndpoint);
            String externalPath = external.getRawPath();
            if (!"https".equalsIgnoreCase(external.getScheme())
                    || external.getHost() == null || external.getUserInfo() != null
                    || external.getRawQuery() != null || external.getRawFragment() != null
                    || (externalPath != null && !externalPath.isEmpty()
                            && !"/".equals(externalPath))) {
                throw new IllegalStateException(
                        "Public export download endpoint must be a trusted HTTPS origin");
            }
            this.exportPresigner = S3Presigner.builder().endpointOverride(external)
                .region(Region.of(this.properties.getRegion()))
                .credentialsProvider(credentialsProvider())
                .serviceConfiguration(serviceConfig).build();
        }
    }

    /** Dedicated SDK trust, preserving Apache's hostname verification. No global JVM truststore changes. */
    public static software.amazon.awssdk.http.apache.ApacheHttpClient.Builder verifiedHttps(String endpoint, Path ca) {
        URI uri = URI.create(endpoint);
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null
                || uri.getQuery() != null || uri.getFragment() != null) {
            throw new IllegalStateException("Explicit S3 trust requires an HTTPS endpoint");
        }
        try {
            var trust = PemTls.trustManager(ca);
            return software.amazon.awssdk.http.apache.ApacheHttpClient.builder()
                .connectionTimeout(Duration.ofSeconds(3)).socketTimeout(Duration.ofSeconds(15))
                .tlsTrustManagersProvider(() -> new javax.net.ssl.TrustManager[]{trust});
        } catch (Exception e) { throw new IllegalStateException("Invalid S3 TLS trust configuration"); }
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
    public String createExportDownloadCapability(String objectKey, Duration ttl,
            String safeFilename, String contentType) {
        if (objectKey == null || !objectKey.matches(
                "^exports/[0-9a-f-]{36}/artifacts/[0-9a-f]{64}[.](pdf|md)$")
                || safeFilename == null || !safeFilename.matches(
                "^meeting-minutes-[0-9a-f-]{36}[.](pdf|md)$")
                || !safeFilename.endsWith(objectKey.endsWith(".pdf") ? ".pdf" : ".md")
                || ttl == null || ttl.compareTo(Duration.ofSeconds(30)) < 0
                || ttl.compareTo(Duration.ofMinutes(5)) > 0
                || !contentType.equals(objectKey.endsWith(".pdf")
                        ? "application/pdf" : "text/markdown; charset=UTF-8")) {
            throw new IllegalArgumentException("Invalid private export capability request");
        }
        var request = GetObjectRequest.builder().bucket(properties.getBucket())
            .key(objectKey).responseContentType(contentType)
            .responseContentDisposition("attachment; filename=\"" + safeFilename + "\"")
            .responseCacheControl("private, no-store").build();
        return exportPresigner.presignGetObject(GetObjectPresignRequest.builder()
            .signatureDuration(ttl).getObjectRequest(request).build())
            .url().toExternalForm();
    }

    @Override
    public StoredObject head(String objectKey) {
        var result = this.client.headObject(HeadObjectRequest.builder().bucket(this.properties.getBucket())
            .key(objectKey).build());
        return new StoredObject(result.contentLength(), result.contentType(), result.eTag(), result.lastModified());
    }

    @Override
    public void downloadTo(String objectKey, Path destination) throws IOException {
        // Callers reserve a private temporary file before reading storage. The SDK's
        // toFile() transformer refuses to write to an existing path, so stream into
        // the reserved file instead of unlinking it and introducing a TOCTOU window.
        try (var output = Files.newOutputStream(destination,
                StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING)) {
            this.client.getObject(GetObjectRequest.builder().bucket(this.properties.getBucket())
                .key(objectKey).build(), ResponseTransformer.toOutputStream(output));
        }
    }

    @Override
    public byte[] readBounded(String objectKey, int maximum) throws IOException {
        if (maximum < 1 || maximum > (objectKey != null && objectKey.startsWith("exports/") ? 33554432 : 8388608)) throw new IllegalArgumentException("Invalid result read limit.");
        try (var input = client.getObject(GetObjectRequest.builder().bucket(properties.getBucket()).key(objectKey).build())) {
            if (input.response().contentLength() == null || input.response().contentLength() > maximum
                    || input.response().contentLength() < 1 || input.response().contentEncoding() != null) {
                input.abort(); throw new IOException("Invalid result object size or encoding.");
            }
            byte[] bytes = input.readNBytes(maximum + 1);
            if (bytes.length > maximum || bytes.length != input.response().contentLength()) {
                input.abort(); throw new IOException("Invalid result object size.");
            }
            return bytes;
        }
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
    public boolean putImmutableBytesIfAbsent(String objectKey, byte[] bytes,
            String contentType, String sha256) {
        if (objectKey == null || !objectKey.startsWith("exports/")
                || bytes == null || bytes.length < 1 || bytes.length > 33554432) {
            throw new IllegalArgumentException("Invalid bounded export object");
        }
        var request = PutObjectRequest.builder()
            .bucket(this.properties.getBucket()).key(objectKey)
            .ifNoneMatch("*").contentType(contentType)
            .contentLength((long) bytes.length)
            .metadata(Map.of("sha256", sha256))
            .build();
        try {
            this.client.putObject(request, RequestBody.fromBytes(bytes));
            return true;
        } catch (S3Exception exception) {
            if (exception.statusCode() == 412) return false;
            // 409 is not proof of acceptance; outer integrity verifier handles it.
            throw exception;
        }
    }

    @Override
    public ListedObjects list(String prefix,String continuationToken,int limit) {
        if(prefix==null || !(prefix.matches("processing/[0-9a-f-]{36}/intelligence/")
                || prefix.equals("exports/")) || limit<1 || limit>100) {
            throw new IllegalArgumentException("Invalid private intelligence object listing scope.");
        }
        var request=ListObjectsV2Request.builder().bucket(properties.getBucket())
            .prefix(prefix).maxKeys(limit);
        if(continuationToken!=null) request.continuationToken(continuationToken);
        var page=client.listObjectsV2(request.build());
        return new ListedObjects(page.contents().stream()
            .map(x->new ListedObject(x.key(),x.lastModified())).toList(),
            Boolean.TRUE.equals(page.isTruncated())?page.nextContinuationToken():null);
    }

    @Override
    public boolean deleteIfEtagMatches(String objectKey, String expectedEtag) {
        // Only the DE-11 orphan-cleanup flow may use this operation. The key
        // must be server-derived and strictly inside the export namespace.
        if (objectKey == null || !objectKey.matches(
                "^exports/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/"
                + "(intake/[0-9a-f]{64}[.]json|snapshots/[0-9a-f]{64}[.]json"
                + "|artifacts/[0-9a-f]{64}[.](md|pdf))$")
                || expectedEtag == null || expectedEtag.isBlank()
                || expectedEtag.length() > 256 || expectedEtag.equals("*")) {
            throw new IllegalArgumentException("Invalid conditional export deletion");
        }
        try {
            client.deleteObject(DeleteObjectRequest.builder()
                .bucket(properties.getBucket()).key(objectKey)
                .ifMatch(expectedEtag).build());
            return true;
        } catch (S3Exception exception) {
            if (exception.statusCode() == 412 || exception.statusCode() == 404) {
                return false;
            }
            throw exception;
        }
    }

    @Override
    public void delete(String objectKey) {
        this.client.deleteObject(DeleteObjectRequest.builder().bucket(this.properties.getBucket()).key(objectKey).build());
    }

    @PreDestroy
    void closeClients() {
        if (this.exportPresigner != this.presigner) this.exportPresigner.close();
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
        // Externally provisioned secure buckets require no ListBucket/admin grant
        // merely to sign a pending-upload URL. The eventual PUT reports absence.
        if (!this.properties.isCreateBucketIfMissing()) return;
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
