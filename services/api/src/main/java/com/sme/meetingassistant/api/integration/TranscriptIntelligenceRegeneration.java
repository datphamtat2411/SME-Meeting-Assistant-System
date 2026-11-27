package com.sme.meetingassistant.api.integration;

import com.sme.meetingassistant.api.media.dto.ProcessingJobResponse;
import com.sme.meetingassistant.api.media.dto.TranscriptReviewRequest;
import com.sme.meetingassistant.api.media.intelligence.IntelligenceWorkerCapability;
import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.repository.MediaRepository.Job;
import com.sme.meetingassistant.api.media.service.DerivedSummaryJobAdmission;
import com.sme.meetingassistant.api.media.service.MediaProcessingService;
import com.sme.meetingassistant.api.media.service.ProcessingTranscriptEvidence;
import com.sme.meetingassistant.api.meeting.service.MeetingMediaAccess;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceSnapshotStore;
import com.sme.meetingassistant.api.transcript.service.TranscriptSnapshotCapture;
import com.sme.meetingassistant.api.transcript.service.TranscriptSourceGuard;
import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository.TranscriptSource;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import java.util.Locale;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/** Admits immutable derived-only work for the current transcript revision. */
@Service
public class TranscriptIntelligenceRegeneration {
    private static final org.slf4j.Logger LOG =
        org.slf4j.LoggerFactory.getLogger(TranscriptIntelligenceRegeneration.class);
    private final MediaRepository media;
    private final MeetingMediaAccess access;
    private final AuthenticatedUserId identity;
    private final ProcessingTranscriptEvidence evidence;
    private final TranscriptSnapshotCapture capture;
    private final TranscriptSourceGuard transcripts;
    private final IntelligenceSnapshotStore store;
    private final DerivedSummaryJobAdmission derived;
    private final IntelligenceWorkerCapability capability;
    private final MediaProcessingService jobs;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final boolean enabled;

    public TranscriptIntelligenceRegeneration(MediaRepository media, MeetingMediaAccess access,
            AuthenticatedUserId identity, ProcessingTranscriptEvidence evidence, TranscriptSnapshotCapture capture,
            TranscriptSourceGuard transcripts,
            IntelligenceSnapshotStore store, DerivedSummaryJobAdmission derived,
            IntelligenceWorkerCapability capability, MediaProcessingService jobs, JdbcTemplate jdbc,
            TransactionTemplate tx, @Value("${app.media.intelligence.regeneration-enabled:false}") boolean enabled) {
        this.media=media; this.access=access; this.identity=identity; this.evidence=evidence;
        this.capture=capture; this.store=store; this.derived=derived; this.capability=capability;
        this.transcripts=transcripts;
        this.jobs=jobs; this.jdbc=jdbc; this.tx=tx; this.enabled=enabled;
    }

    public ProcessingJobResponse regenerate(UUID originId, TranscriptReviewRequest request, String key) {
        UUID actor = identity.requireUserId();
        Job origin = media.findJob(originId).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        access.requireProcessingAllowed(origin.meetingId(), actor);
        if (key == null || key.isBlank() || key.length() > 255 || !key.equals(key.strip())
                || key.chars().anyMatch(Character::isISOControl)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Valid Idempotency-Key is required.");
        }
        String digest = request.correctionDigest().toLowerCase(Locale.ROOT);
        if (!digest.matches("[0-9a-f]{64}")) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "A valid correction digest is required.");
        }
        String operation = "REVIEWED_MI_REGENERATION:" + originId; // preserve existing idempotency receipts
        String fingerprint = com.sme.meetingassistant.api.media.worker.WorkerJson.sha256(
            (request.transcriptId() + "\n" + request.contentRevision() + "\n" + digest)
                .getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (!enabled) throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
            "Meeting Intelligence regeneration is not enabled.");
        try {
            var replay = media.findIdempotentJob(actor, operation, key, fingerprint);
            if (replay.isPresent()) return jobs.getJob(replay.get());
            requireTerminal(origin);
            List<String> stages = enabledStages();
            if (stages.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Required intelligence stages are not ready.");
            }
            var source = capture.capture(origin.meetingId());
            if (!originId.equals(source.originJobId()) || !origin.sourceMediaId().equals(source.mediaId())
                    || !request.transcriptId().equals(source.transcriptId())
                    || request.contentRevision()!=source.contentRevision() || !digest.equals(source.correctionDigest())) {
                throw stale();
            }
            UUID jobId = UUID.randomUUID(), snapshotId = UUID.randomUUID();
            var saved = store.put(jobId, snapshotId, source.bytes());
            boolean committed = false;
            try {
                UUID admitted = tx.execute(status -> {
                    media.lockAdmissionUser(actor);
                    evidence.lockTranscriptReview(originId);
                    access.requireProcessingAllowed(origin.meetingId(), actor);
                    Job locked = media.lockJobForOfflineSource(originId).orElseThrow(TranscriptIntelligenceRegeneration::stale);
                    var claim = media.claimIdempotencyWithStatus(actor, operation, key, fingerprint, jobId);
                    if (!claim.claimed()) return claim.resourceId();
                    requireTerminal(locked);
                    var current = evidence.currentTranscriptReview(originId).orElseThrow(TranscriptIntelligenceRegeneration::stale);
                    if (!current.sourceMediaId().equals(source.mediaId()) || !current.transcriptId().equals(source.transcriptId())
                            || current.contentRevision()!=source.contentRevision()
                            || !digest.equals(current.correctionDigest())) throw stale();
                    persist(locked, actor, jobId, snapshotId, source, saved, stages);
                    return jobId;
                });
                committed = jobId.equals(admitted);
                return jobs.getJob(admitted);
            } finally {
                if (!committed) store.cleanup(saved.key());
            }
        } catch (MediaRepository.IdempotencyConflictException conflict) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "Idempotency-Key already identifies a different transcript revision.");
        } catch (MediaRepository.JobAdmissionConflictException conflict) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Another processing job occupies the meeting.");
        }
    }

    private static void requireTerminal(Job origin) {
        if (!"OFFLINE_MEETING_PROCESSING".equals(origin.jobType())
                || !Set.of("FAILED","COMPLETED","COMPLETED_WITH_WARNINGS").contains(origin.status())) throw stale();
    }

    /** Participates in the canonical edit transaction; repeated edits replace pending work. */
    @org.springframework.context.event.EventListener
    public void requestRefresh(com.sme.meetingassistant.api.transcript.service.TranscriptRevisionChanged change) {
        jdbc.update("""
            INSERT INTO transcript_intelligence_refresh(meeting_id,transcript_id,content_revision,requested_by,due_at)
            VALUES (?,?,?,?,clock_timestamp()+interval '10 seconds')
            ON CONFLICT(meeting_id) DO UPDATE SET transcript_id=excluded.transcript_id,
              content_revision=excluded.content_revision,requested_by=excluded.requested_by,
              due_at=excluded.due_at,claim_token=NULL,attempts=0,last_error=NULL
            WHERE (transcript_intelligence_refresh.transcript_id, transcript_intelligence_refresh.content_revision)
              IS DISTINCT FROM (excluded.transcript_id,excluded.content_revision)
            """, change.meetingId(), change.transcriptId(), change.contentRevision(), change.actorId());
    }

    @Scheduled(fixedDelayString = "${app.media.intelligence.refresh-poll-ms:10000}")
    public void refreshEditedTranscripts() {
        List<String> stages = enabledStages();
        if (stages.isEmpty()) return;
        for (int count = 0; count < 4; count++) {
            UUID token = UUID.randomUUID();
            var requests = jdbc.query("""
                WITH due AS (
                  SELECT r.meeting_id FROM transcript_intelligence_refresh r
                  WHERE r.due_at <= clock_timestamp() AND r.attempts < 5
                    AND NOT EXISTS(SELECT 1 FROM processing_jobs j WHERE j.meeting_id=r.meeting_id
                      AND j.status IN ('PENDING','QUEUED','RUNNING','WAITING_FOR_REVIEW'))
                  ORDER BY r.due_at,r.meeting_id LIMIT 1 FOR UPDATE OF r SKIP LOCKED
                )
                UPDATE transcript_intelligence_refresh r SET claim_token=?,due_at=clock_timestamp()+interval '3 minutes',
                    attempts=CASE WHEN r.claim_token IS NULL THEN r.attempts ELSE r.attempts+1 END
                FROM due WHERE r.meeting_id=due.meeting_id
                RETURNING r.meeting_id,r.transcript_id,r.content_revision,r.requested_by
                """, (rs, n) -> new Refresh(rs.getObject(1,UUID.class), rs.getObject(2,UUID.class),
                    rs.getLong(3), rs.getObject(4,UUID.class)), token);
            if (requests.isEmpty()) return;
            Refresh request = requests.getFirst();
            try {
                refresh(request, token, stages);
            } catch (ResponseStatusException conflict) {
                int status = conflict.getStatusCode().value();
                if (status == 403 || status == 404) finish(request, token);
                else if (status == 409 || status == 429) defer(request, token, false);
                else defer(request, token, true);
            } catch (MediaRepository.JobAdmissionConflictException busy) {
                defer(request, token, false);
            } catch (RuntimeException unavailable) {
                defer(request, token, true);
            }
        }
    }

    private void refresh(Refresh request, UUID token, List<String> stages) {
        access.requireTranscriptRefreshAllowed(request.meeting(), request.actor());
        var source = capture.capture(request.meeting());
        if (!source.transcriptId().equals(request.transcript()) || source.contentRevision()!=request.revision()
                || hasAllStages(request, stages)) {
            finish(request, token);
            return;
        }
        Job origin = media.findJob(source.originJobId()).orElseThrow(TranscriptIntelligenceRegeneration::stale);
        requireTerminal(origin);
        derivedCapacity(request);
        UUID job = UUID.randomUUID(), snapshot = UUID.randomUUID();
        var saved = store.put(job, snapshot, source.bytes());
        boolean committed = false;
        try {
            committed = Boolean.TRUE.equals(tx.execute(transaction -> {
                media.lockAdmissionUser(request.actor());
                transcripts.requireCurrentForDerivedWrite(request.meeting(),
                    new TranscriptSource(request.transcript(), request.revision(), source.status()));
                access.requireTranscriptRefreshAllowed(request.meeting(), request.actor());
                if (finish(request, token) != 1 || hasAllStages(request, stages)) return false;
                persist(origin, request.actor(), job, snapshot, source, saved, stages);
                return true;
            }));
        } finally {
            if (!committed) store.cleanup(saved.key());
        }
    }

    private void derivedCapacity(Refresh request) {
        tx.executeWithoutResult(transaction -> derived.requireCapacity(request.actor(),request.meeting()));
    }

    private boolean hasAllStages(Refresh request, List<String> stages) {
        return Boolean.TRUE.equals(jdbc.queryForObject("""
            SELECT count(DISTINCT s.stage_code)=? FROM meeting_intelligence_source_snapshots x
            JOIN processing_stage_runs s ON s.processing_job_id=x.processing_job_id
            WHERE x.meeting_id=? AND x.transcript_id=? AND x.content_revision=?
              AND s.stage_code=ANY(CAST(? AS text[])) AND s.status IN ('SUCCEEDED','SUCCEEDED_WITH_WARNING')
            """, Boolean.class, stages.size(), request.meeting(),request.transcript(), request.revision(),
            "{"+String.join(",",stages)+"}"));
    }

    private int finish(Refresh request, UUID token) {
        return jdbc.update("DELETE FROM transcript_intelligence_refresh WHERE meeting_id=? AND claim_token=?",
            request.meeting(), token);
    }

    private void defer(Refresh request, UUID token, boolean failure) {
        jdbc.update("""
            UPDATE transcript_intelligence_refresh SET claim_token=NULL,due_at=clock_timestamp()+interval '2 minutes',
              attempts=LEAST(5,attempts+?),last_error=?
            WHERE meeting_id=? AND claim_token=?
            """, failure ? 1 : 0, failure ? "REFRESH_PREPARATION_FAILED" : "REFRESH_DEFERRED", request.meeting(), token);
        if (failure) LOG.warn("intelligence.refresh.preparation_failed meeting_id={} revision={}",
            request.meeting(), request.revision());
    }

    private List<String> enabledStages() {
        return IntelligenceWorkerCapability.ORDER.stream().filter(capability::canDispatch).toList();
    }

    private void persist(Job origin, UUID actor, UUID job, UUID snapshot, TranscriptSnapshotCapture.Captured source,
            IntelligenceSnapshotStore.Snapshot saved, List<String> stages) {
        if (media.findMedia(origin.sourceMediaId()).filter(m -> "AVAILABLE".equals(m.status())).isEmpty())
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Source media is no longer available.");
        derived.admitTranscriptRevision(job, origin, actor, stages);
        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots
                (id,meeting_id,source_media_id,processing_job_id,transcript_id,content_revision,sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,?,?,?,?)
            """, snapshot,origin.meetingId(),source.mediaId(),job,source.transcriptId(),
            source.contentRevision(),saved.sha256(),saved.key(),saved.sizeBytes());
    }

    private static ResponseStatusException stale() {
        return new ResponseStatusException(HttpStatus.CONFLICT,
            "Regeneration requires the current finalized transcript revision and digest.");
    }

    private record Refresh(UUID meeting, UUID transcript, long revision, UUID actor) {}
}
