package com.sme.meetingassistant.api.media.storage;

import java.io.IOException;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;

public interface ObjectStorage {
    String createUploadCapability(String objectKey, String contentType, long contentLength, Duration ttl);
    String createDownloadCapability(String objectKey, Duration ttl);
    StoredObject head(String objectKey);
    void downloadTo(String objectKey, Path destination) throws IOException;
    /** Bounded private control-result read. Implementations must enforce the limit during streaming. */
    default byte[] readBounded(String objectKey, int maximum) throws IOException {
        throw new UnsupportedOperationException("Bounded result storage is not installed.");
    }
    /** Create an accepted source once. False means an object already exists at this key. */
    boolean putAcceptedIfAbsent(String objectKey, Path validatedFile, String sha256);
    /**
     * Private server-side immutable byte write. Does not issue client capabilities.
     * Export-only callers enforce a bounded object size and verify a subsequent GET.
     */
    default boolean putImmutableBytesIfAbsent(String objectKey, byte[] bytes,
            String contentType, String sha256) {
        throw new UnsupportedOperationException("Immutable private bytes storage is not installed.");
    }
    void delete(String objectKey);
    /** Server-side bounded listing; never expose this namespace to callers. */
    ListedObjects list(String prefix,String continuationToken,int limit);

    record StoredObject(long sizeBytes, String contentType, String eTag) { }
    record ListedObject(String key,Instant lastModified) { }
    record ListedObjects(List<ListedObject> objects,String nextToken) {
        public ListedObjects {
            objects=List.copyOf(objects);
        }
    }
}
