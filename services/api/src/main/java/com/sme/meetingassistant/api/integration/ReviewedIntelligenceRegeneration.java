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
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/** Admits fresh MI work only from an exact, already admitted human transcript review. */
@Service
public class ReviewedIntelligenceRegeneration {
    private final MediaRepository media;
    private final MeetingMediaAccess access;
    private final AuthenticatedUserId identity;
    private final ProcessingTranscriptEvidence evidence;
    private final TranscriptSnapshotCapture capture;
    private final IntelligenceSnapshotStore store;
    private final DerivedSummaryJobAdmission derived;
    private final IntelligenceWorkerCapability capability;
    private final MediaProcessingService jobs;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    private final boolean enabled;

    public ReviewedIntelligenceRegeneration(MediaRepository media, MeetingMediaAccess access,
            AuthenticatedUserId identity, ProcessingTranscriptEvidence evidence, TranscriptSnapshotCapture capture,
            IntelligenceSnapshotStore store, DerivedSummaryJobAdmission derived,
            IntelligenceWorkerCapability capability, MediaProcessingService jobs, JdbcTemplate jdbc,
            TransactionTemplate tx, @Value("${app.media.intelligence.regeneration-enabled:false}") boolean enabled) {
        this.media=media; this.access=access; this.identity=identity; this.evidence=evidence;
        this.capture=capture; this.store=store; this.derived=derived; this.capability=capability;
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
        String operation = "REVIEWED_MI_REGENERATION:" + originId;
        String fingerprint = com.sme.meetingassistant.api.media.worker.WorkerJson.sha256(
            (request.transcriptId() + "\n" + request.contentRevision() + "\n" + digest)
                .getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (!enabled) throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
            "Meeting Intelligence regeneration is not enabled.");
        try {
            var replay = media.findIdempotentJob(actor, operation, key, fingerprint);
            if (replay.isPresent()) return jobs.getJob(replay.get());
            requireTerminal(origin);
            UUID reviewId = requireReview(origin, request, digest);
            if (!IntelligenceWorkerCapability.ORDER.stream().allMatch(capability::canDispatch)) {
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
                    Job locked = media.lockJobForOfflineSource(originId).orElseThrow(ReviewedIntelligenceRegeneration::stale);
                    var claim = media.claimIdempotencyWithStatus(actor, operation, key, fingerprint, jobId);
                    if (!claim.claimed()) return claim.resourceId();
                    requireTerminal(locked);
                    var current = evidence.currentTranscriptReview(originId).orElseThrow(ReviewedIntelligenceRegeneration::stale);
                    if (!current.sourceMediaId().equals(source.mediaId()) || !current.transcriptId().equals(source.transcriptId())
                            || current.contentRevision()!=source.contentRevision() || !digest.equals(current.correctionDigest())
                            || !reviewId.equals(requireReview(locked, request, digest))) throw stale();
                     if (media.findMedia(origin.sourceMediaId()).filter(m -> "AVAILABLE".equals(m.status())).isEmpty())
                         throw stale();
                     derived.admitReviewed(jobId, locked, actor, reviewId);
                    jdbc.update("""
                        INSERT INTO meeting_intelligence_source_snapshots
                            (id,meeting_id,source_media_id,processing_job_id,transcript_id,
                             content_revision,sha256,object_key,size_bytes)
                        VALUES (?,?,?,?,?,?,?,?,?)
                        """, snapshotId,origin.meetingId(),source.mediaId(),jobId,source.transcriptId(),
                        source.contentRevision(),saved.sha256(),saved.key(),saved.sizeBytes());
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
        if (!origin.transcriptReviewRequired() || !"OFFLINE_MEETING_PROCESSING".equals(origin.jobType())
                || !Set.of("FAILED","COMPLETED","COMPLETED_WITH_WARNINGS").contains(origin.status())) throw stale();
    }

    private UUID requireReview(Job origin, TranscriptReviewRequest request, String digest) {
        return media.admittedReview(origin.id(), origin.meetingId(), request.transcriptId(),
            request.contentRevision(), digest).orElseThrow(ReviewedIntelligenceRegeneration::stale);
    }

    private static ResponseStatusException stale() {
        return new ResponseStatusException(HttpStatus.CONFLICT,
            "Regeneration requires the current transcript revision and digest from the original admitted review.");
    }
}
