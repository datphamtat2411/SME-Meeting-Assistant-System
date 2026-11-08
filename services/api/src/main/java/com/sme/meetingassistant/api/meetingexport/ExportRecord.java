package com.sme.meetingassistant.api.meetingexport;

import java.time.OffsetDateTime;
import java.util.UUID;

/**
 * Server-internal persistence projection; includes sensitive object references
 * and claim fields. NEVER serialize this record directly in a public API.
 */
public record ExportRecord(
        UUID id, UUID meetingId, ExportFormat format, ExportStatus status,
        UUID requestedByUserId, OffsetDateTime createdAt, OffsetDateTime readyAt,
        String objectKey, String sourceFingerprint, String lastErrorCode,
        int generationAttempt, UUID claimToken, OffsetDateTime leaseExpiresAt,
        String snapshotObjectKey, String rendererVersion, String artifactSha256,
        Long artifactSizeBytes, long rowVersion) {
}
