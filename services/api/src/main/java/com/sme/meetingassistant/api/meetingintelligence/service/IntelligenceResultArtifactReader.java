package com.sme.meetingassistant.api.meetingintelligence.service;

import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Trusted internal storage boundary, not a public upload endpoint. Reads bytes
 * from a server-constructed job/stage namespace, never a worker-supplied URL.
 * The receipt digest describes the exact bytes actually downloaded.
 */
@Component
public class IntelligenceResultArtifactReader {
    private static final long MAX_RESULT_BYTES = 4L * 1024 * 1024;
    private final ObjectStorage storage;

    public IntelligenceResultArtifactReader(ObjectStorage storage) {
        this.storage = storage;
    }

    public ResultArtifact read(UUID jobId, UUID stageRunId, String expectedSha256) {
        if (jobId == null || stageRunId == null || expectedSha256 == null
                || !expectedSha256.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("Result identity and digest are required.");
        }
        String key = "processing/" + jobId + "/intelligence/results/" + stageRunId + ".json";
        Path temp = null;
        try {
            // HEAD rejects oversized objects before downloading; the *downloaded*
            // file is also checked because metadata cannot be trusted as proof.
            ObjectStorage.StoredObject head = storage.head(key);
            if (head.sizeBytes() < 1 || head.sizeBytes() > MAX_RESULT_BYTES) {
                throw new IllegalArgumentException("Intelligence result artifact has invalid size.");
            }
            temp = Files.createTempFile("mi-result-", ".json");
            storage.downloadTo(key, temp);
            long size = Files.size(temp);
            if (size < 1 || size > MAX_RESULT_BYTES || size != head.sizeBytes()) {
                throw new IllegalArgumentException("Intelligence result bytes do not match storage metadata.");
            }
            byte[] bytes = Files.readAllBytes(temp);
            String actual = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
            if (!expectedSha256.equals(actual)) {
                throw new IllegalArgumentException("Intelligence result artifact digest mismatch.");
            }
            return new ResultArtifact(key, actual, size, bytes);
        } catch (IOException exception) {
            // No external object URLs, raw bytes, or worker payload in errors.
            throw new IllegalStateException("Could not read trusted intelligence artifact.", exception);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable.", impossible);
        } finally {
            if (temp != null) {
                try { Files.deleteIfExists(temp); }
                catch (IOException ignored) { /* bounded OS temporary file, do not mask ingest error */ }
            }
        }
    }

    public record ResultArtifact(String objectKey, String sha256, long sizeBytes, byte[] bytes) {
        public ResultArtifact {
            bytes = bytes.clone();
        }
        @Override public byte[] bytes() { return bytes.clone(); }
    }
}
