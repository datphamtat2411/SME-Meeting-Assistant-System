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
    /** Create an accepted source once. False means an object already exists at this key. */
    boolean putAcceptedIfAbsent(String objectKey, Path validatedFile, String sha256);
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
