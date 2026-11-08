package com.sme.meetingassistant.api.meetingexport;

import java.time.Duration;

/**
 * Server-internal export-specific capability port. Implementations must verify
 * READY artifact metadata, byte checksum and private storage availability
 * before returning a short-lived presigned URL.
 */
public interface ExportDownloadStore {
    String createVerifiedCapability(ExportRecord readyRecord, Duration ttl);
}
