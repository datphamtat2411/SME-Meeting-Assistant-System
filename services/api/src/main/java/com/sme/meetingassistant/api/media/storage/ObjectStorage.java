package com.sme.meetingassistant.api.media.storage;

import java.io.IOException;
import java.nio.file.Path;
import java.time.Duration;

public interface ObjectStorage {
    String createUploadCapability(String objectKey, String contentType, long contentLength, Duration ttl);
    String createDownloadCapability(String objectKey, Duration ttl);
    StoredObject head(String objectKey);
    void downloadTo(String objectKey, Path destination) throws IOException;
    /** Create an accepted source once. False means an object already exists at this key. */
    boolean putAcceptedIfAbsent(String objectKey, Path validatedFile, String sha256);
    void delete(String objectKey);

    record StoredObject(long sizeBytes, String contentType, String eTag) { }
}
