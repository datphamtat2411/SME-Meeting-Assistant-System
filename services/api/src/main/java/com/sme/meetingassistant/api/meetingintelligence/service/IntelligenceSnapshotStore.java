package com.sme.meetingassistant.api.meetingintelligence.service;

import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

/** Restricted immutable source JSON storage; no client-writable upload capability. */
@Component
public class IntelligenceSnapshotStore {
    private final ObjectStorage storage;
    public IntelligenceSnapshotStore(ObjectStorage storage) { this.storage=storage; }

    public Snapshot put(UUID jobId, UUID snapshotId, byte[] bytes) {
        if (bytes == null || bytes.length < 1 || bytes.length > 8 * 1024 * 1024)
            throw new IllegalArgumentException("Invalid derived source snapshot size.");
        String key="processing/"+jobId+"/intelligence/source/"+snapshotId+".json";
        String sha=digest(bytes);
        Path local=null, verify=null;
        boolean created=false;
        try {
            local=Files.createTempFile("mi-source-", ".json");
            Files.write(local, bytes);
            if (!storage.putAcceptedIfAbsent(key, local, sha)) {
                throw new IllegalStateException("Immutable snapshot object key is already occupied.");
            }
            created=true;
            var head=storage.head(key);
            if (head.sizeBytes()!=bytes.length)
                throw new IllegalStateException("Stored source snapshot size is incorrect.");
            verify=Files.createTempFile("mi-verified-", ".json");
            storage.downloadTo(key, verify);
            if (Files.size(verify)!=bytes.length
                    || !sha.equals(digest(Files.readAllBytes(verify)))) {
                throw new IllegalStateException("Stored snapshot bytes failed integrity verification.");
            }
            return new Snapshot(key,sha,bytes.length);
        } catch (IOException | RuntimeException failure) {
            if (created) cleanup(key);
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Immutable transcript snapshot storage is unavailable.",failure);
        } finally {
            remove(local);
            remove(verify);
        }
    }

    public void cleanup(String key) {
        try { storage.delete(key); }
        catch (RuntimeException ignored) { /* Retention sweep must clear rare orphan snapshots. */ }
    }

    private static void remove(Path path) {
        if (path!=null) try { Files.deleteIfExists(path); } catch (IOException ignored) { }
    }
    private static String digest(byte[] bytes) {
        try { return HexFormat.of().formatHex(
            MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    public record Snapshot(String key,String sha256,long sizeBytes) { }
}
