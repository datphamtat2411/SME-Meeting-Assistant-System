package com.sme.meetingassistant.api.media.storage;

import java.nio.file.Path;
import java.time.Duration;

public interface ObjectStorage {
    String createUploadCapability(String objectKey, String contentType, long contentLength, Duration ttl);
    String createDownloadCapability(String objectKey, Duration ttl);
    StoredObject head(String objectKey);
    void downloadTo(String objectKey, Path destination);
    void delete(String objectKey);

    record StoredObject(long sizeBytes, String contentType, String eTag) { }
}
