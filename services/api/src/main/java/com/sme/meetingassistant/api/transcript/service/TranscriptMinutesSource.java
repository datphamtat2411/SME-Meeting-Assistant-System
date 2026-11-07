package com.sme.meetingassistant.api.transcript.service;

import java.util.Optional;
import java.util.UUID;

/**
 * Transcript-owned current-source metadata reference. Does not load or expose
 * full speech text; quality and coverage limitations must survive into Minutes.
 */
public interface TranscriptMinutesSource {
    Optional<Reference> currentReference(UUID meetingId);

    record Reference(UUID id, UUID processingJobId, int versionNumber, String languageCode,
            String status, long contentRevision, Long durationMs,
            long suspiciousSegments, long unresolvedSegments,
            long unresolvedCoverageRegions) { }
}
