package com.sme.meetingassistant.api.meetingintelligence.service;

import com.sme.meetingassistant.api.media.service.DerivedSummaryJobAdmission;
import com.sme.meetingassistant.api.meeting.service.MeetingIntelligenceAccess;
import com.sme.meetingassistant.api.meetingintelligence.dto.RegenerateSummaryResponse;
import com.sme.meetingassistant.api.transcript.service.TranscriptSnapshotCapture;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Two-phase admission: consistent capture -> immutable verified object -> short
 * DB transaction with source recheck, idempotency, quotas and durable dispatch.
 * Disabled until a compatible derived worker is explicitly deployed.
 */
@Service
public class SummaryRegenerationService {
    private final MeetingIntelligenceAccess access;
    private final AuthenticatedUserId identity;
    private final TranscriptSnapshotCapture capture;
    private final IntelligenceSnapshotStore storage;
    private final SummaryRegenerationAdmission admission;
    private final DerivedSummaryJobAdmission media;
    private final JdbcTemplate jdbc;
    private final boolean enabled;

    public SummaryRegenerationService(MeetingIntelligenceAccess access,AuthenticatedUserId identity,
            TranscriptSnapshotCapture capture,IntelligenceSnapshotStore storage,
            SummaryRegenerationAdmission admission,DerivedSummaryJobAdmission media,
            JdbcTemplate jdbc,
            @Value("${app.meeting-intelligence.regeneration.enabled:false}") boolean enabled) {
        this.access=access;this.identity=identity;this.capture=capture;this.storage=storage;
        this.admission=admission;this.media=media;this.jdbc=jdbc;this.enabled=enabled;
    }

    public RegenerateSummaryResponse regenerate(UUID meetingId,String idempotencyKey) {
        UUID actor=identity.requireUserId();
        access.requireSummaryRegenerationAllowed(meetingId,actor);
        if (idempotencyKey==null || idempotencyKey.isBlank() || idempotencyKey.length()>255
                || !idempotencyKey.equals(idempotencyKey.strip())
                || idempotencyKey.chars().anyMatch(Character::isISOControl)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                "Valid Idempotency-Key is required.");
        }
        if (!enabled) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Summary regeneration worker is not enabled.");
        }
        // This read-only fast path prevents needless object writes on retries.
        var old=media.existing(actor,meetingId,idempotencyKey);
        if(old.isPresent()) return response(meetingId,old.get());

        var source=capture.capture(meetingId);
        UUID jobId=UUID.randomUUID(),snapshotId=UUID.randomUUID();
        var stored=storage.put(jobId,snapshotId,source.bytes());
        boolean committed=false;
        try {
            // Permissions may be revoked while the object store is responding.
            access.requireSummaryRegenerationAllowed(meetingId,actor);
            var result=admission.persist(meetingId,actor,idempotencyKey,
                jobId,snapshotId,source,stored);
            committed=result.created();
            return response(meetingId,result.jobId());
        } finally {
            // The finalization transaction rolls back on every failure, so
            // never leave a failed admission's orphan object intentionally.
            if(!committed) storage.cleanup(stored.key());
        }
    }

    private RegenerateSummaryResponse response(UUID meetingId,UUID jobId) {
        var sources=jdbc.query("""
            SELECT transcript_id,content_revision
            FROM meeting_intelligence_source_snapshots
            WHERE meeting_id=? AND processing_job_id=?
            """,(rs,n)->new Source(rs.getObject("transcript_id",UUID.class),
                rs.getLong("content_revision")),meetingId,jobId);
        if (sources.size()!=1)
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "Derived job does not have a pinned transcript snapshot.");
        return new RegenerateSummaryResponse(jobId,meetingId,media.status(jobId),
            sources.getFirst().transcriptId(),sources.getFirst().revision());
    }

    private record Source(UUID transcriptId,long revision) { }
}
