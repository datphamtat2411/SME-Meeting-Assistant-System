package com.sme.meetingassistant.api.meetingexport;

import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import java.io.IOException;
import java.util.Objects;
import org.springframework.stereotype.Component;

/**
 * Storage writes are conditional and followed by a bounded GET + SHA-256.
 * S3 metadata/ETag alone is not treated as a content-integrity proof.
 * Namespace is server-generated; never accept a user-supplied storage key.
 */
@Component
public final class S3ExportArtifactStore implements ExportArtifactStore, ExportDownloadStore {
    private static final int MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
    private final ObjectStorage storage;

    public S3ExportArtifactStore(ObjectStorage storage) {
        this.storage = storage;
    }

    @Override
    public void putVerified(String key, byte[] bytes, String contentType, String sha256) {
        requireNamespace(key);
        ExportDigests.requireDigest(sha256);
        if (bytes == null || bytes.length == 0 || bytes.length > MAX_ARTIFACT_BYTES
                || !sha256.equals(ExportSnapshotCodec.sha256(bytes))) {
            throw new IntegrityFailure("Export source bytes do not match checksum");
        }
        try {
            storage.putImmutableBytesIfAbsent(key, bytes, contentType, sha256);
            var head = storage.head(key);
            if (head.sizeBytes() != bytes.length
                    || !Objects.equals(head.contentType(), contentType)) {
                throw new IntegrityFailure("Persisted export object metadata mismatch");
            }
            byte[] observed = storage.readBounded(key, bytes.length);
            if (observed.length != bytes.length
                    || !sha256.equals(ExportSnapshotCodec.sha256(observed))) {
                throw new IntegrityFailure("Persisted export content checksum mismatch");
            }
        } catch (IOException | RuntimeException ex) {
            if (ex instanceof IntegrityFailure integrity) throw integrity;
            throw new StorageFailure("Private export storage failed", ex);
        }
    }

    @Override
    public byte[] readVerified(String key, String expectedSha256, int maximumBytes) {
        requireNamespace(key);
        ExportDigests.requireDigest(expectedSha256);
        if (maximumBytes < 1 || maximumBytes > MAX_ARTIFACT_BYTES) {
            throw new IllegalArgumentException("Invalid export read bound");
        }
        try {
            byte[] bytes = storage.readBounded(key, maximumBytes);
            if (bytes.length == 0 || !expectedSha256.equals(
                    ExportSnapshotCodec.sha256(bytes))) {
                throw new IntegrityFailure("Pinned export object failed integrity check");
            }
            return bytes;
        } catch (IOException | RuntimeException ex) {
            if (ex instanceof IntegrityFailure integrity) throw integrity;
            throw new StorageFailure("Private export storage read failed", ex);
        }
    }

    /**
     * Downloads are NOT issued against an unverified READY record.
     * Rechecking the complete object digest costs one bounded read (32 MiB
     * maximum), but prevents issuing capabilities to corrupted/replaced data.
     * DE-12 may benchmark a trusted checksum-backed optimization later.
     */
    @Override
    public String createVerifiedCapability(ExportRecord record, java.time.Duration ttl) {
        if (record == null || record.status() != ExportStatus.READY
                || record.artifactSha256() == null
                || record.artifactSizeBytes() == null
                || record.artifactSizeBytes() < 1
                || record.artifactSizeBytes() > MAX_ARTIFACT_BYTES
                || record.readyAt() == null
                || !ExportDigests.artifactKey(record.id(), record.format(),
                        record.artifactSha256()).equals(record.objectKey())) {
            throw new IntegrityFailure("Persisted export metadata does not match READY artifact");
        }
        String contentType = record.format() == ExportFormat.PDF
                ? "application/pdf" : "text/markdown; charset=UTF-8";
        try {
            var head = storage.head(record.objectKey());
            if (head.sizeBytes() != record.artifactSizeBytes()
                    || !contentType.equals(head.contentType())) {
                throw new IntegrityFailure("Export object metadata mismatch");
            }
            // Whole-content integrity proof; S3 ETag alone is not a SHA-256.
            byte[] bytes = storage.readBounded(record.objectKey(),
                    Math.toIntExact(record.artifactSizeBytes()));
            if (bytes.length != record.artifactSizeBytes()
                    || !record.artifactSha256().equals(ExportSnapshotCodec.sha256(bytes))) {
                throw new IntegrityFailure("Export object checksum mismatch");
            }
            String filename = "meeting-minutes-" + record.id() + "." + record.format().extension();
            return storage.createExportDownloadCapability(record.objectKey(), ttl,
                    filename, contentType);
        } catch (IOException | RuntimeException ex) {
            if (ex instanceof IntegrityFailure integrity) throw integrity;
            throw new StorageFailure("Verified private export capability failed", ex);
        }
    }

    private static void requireNamespace(String key) {
        if (key == null || !key.matches(
                "exports/[0-9a-f-]{36}/(intake|snapshots|artifacts)/[0-9a-f]{64}[.](json|md|pdf)")) {
            throw new IllegalArgumentException("Invalid server export object key");
        }
    }
}
