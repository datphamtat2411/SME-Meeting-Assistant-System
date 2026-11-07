package com.sme.meetingassistant.api.meetingexport;

import com.sme.meetingassistant.api.meeting.service.MeetingMediaAccess;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import java.net.URI;
import java.time.Clock;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * DE-10: download capability is never authority by requester ID, admin role
 * or previously issued URL. Enforces CURRENT meeting-content permission both
 * before storage work and immediately before the URL leaves this boundary.
 *
 * A previously issued signed URL cannot be revoked independently of storage;
 * its strictly short TTL is an explicit security limitation.
 */
@Service
public class ExportAccessService {
    private final MeetingExportRepository records;
    private final MeetingMediaAccess meeting;
    private final AuthenticatedUserId user;
    private final ExportDownloadStore privateStore;
    private final Clock clock;
    private final Duration ttl;

    public ExportAccessService(MeetingExportRepository records, MeetingMediaAccess meeting,
            AuthenticatedUserId user, ExportDownloadStore privateStore, Clock clock,
            @Value("${app.exports.download.ttl-seconds:60}") int ttlSeconds) {
        if (ttlSeconds < 30 || ttlSeconds > 300) {
            throw new IllegalArgumentException("Export download TTL must be 30..300 seconds");
        }
        this.records = records;
        this.meeting = meeting;
        this.user = user;
        this.privateStore = privateStore;
        this.clock = clock;
        this.ttl = Duration.ofSeconds(ttlSeconds);
    }

    public record AccessCapability(UUID exportId, String accessUrl, String filename,
            String contentType, OffsetDateTime expiresAt) { }

    public AccessCapability issue(UUID exportId) {
        ExportRecord record = records.require(exportId);
        UUID actor = user.requireUserId();
        // Meet content gate, not generic global role/Action Item visibility.
        meeting.requireReadable(record.meetingId(), actor);
        if (record.status() != ExportStatus.READY) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Export artifact is not READY for download");
        }
        OffsetDateTime requestedAt = clock.instant().atOffset(ZoneOffset.UTC);
        String signed;
        try {
            signed = privateStore.createVerifiedCapability(record, ttl);
            URI u = URI.create(signed);
            if (!"https".equalsIgnoreCase(u.getScheme()) || u.getHost() == null
                    || u.getUserInfo() != null || u.getFragment() != null
                    || u.getRawQuery() == null || u.getRawQuery().isBlank()) {
                throw new IllegalArgumentException("Non-HTTPS or unsigned capability");
            }
        } catch (RuntimeException failure) {
            // Never return object names, provider errors or partial signed URLs.
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Private export artifact temporarily unavailable");
        }
        // Recheck after potentially long HEAD/GET/presign and before response.
        meeting.requireReadable(record.meetingId(), actor);
        return new AccessCapability(exportId, signed,
                "meeting-minutes-" + record.id() + "." + record.format().extension(),
                record.format() == ExportFormat.PDF
                    ? "application/pdf" : "text/markdown; charset=UTF-8",
                requestedAt.plus(ttl));
    }
}
