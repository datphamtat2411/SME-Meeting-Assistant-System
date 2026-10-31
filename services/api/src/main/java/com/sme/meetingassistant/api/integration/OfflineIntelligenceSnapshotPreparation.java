package com.sme.meetingassistant.api.integration;

import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.repository.MediaRepository.ProcessingLifecycleConflictException;
import com.sme.meetingassistant.api.media.service.ProcessingTranscriptEvidence;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceSnapshotStore;
import com.sme.meetingassistant.api.transcript.service.TranscriptSnapshotCapture;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * API-owned preflight for a normal offline intelligence stage.
 *
 * Stage claiming can have an outer Media transaction. NOT_SUPPORTED suspends
 * that transaction so no database row lock is held across object-store I/O.
 * Capture and persistence use their own short, independently committed DB
 * transactions; an orphaned object is cleaned on any losing/failed admission.
 */
@Service
public class OfflineIntelligenceSnapshotPreparation {
    private final MediaRepository media;
    private final ProcessingTranscriptEvidence evidence;
    private final JdbcTemplate jdbc;
    private final TranscriptSnapshotCapture capture;
    private final IntelligenceSnapshotStore store;
    private final OfflineIntelligenceSnapshotPersistence persistence;

    public OfflineIntelligenceSnapshotPreparation(MediaRepository media,
            ProcessingTranscriptEvidence evidence, JdbcTemplate jdbc,
            TranscriptSnapshotCapture capture, IntelligenceSnapshotStore store,
            OfflineIntelligenceSnapshotPersistence persistence) {
        this.media=media;this.evidence=evidence;this.jdbc=jdbc;
        this.capture=capture;this.store=store;this.persistence=persistence;
    }

    @Transactional(propagation=Propagation.NOT_SUPPORTED)
    public void prepare(UUID jobId) {
        var job=media.findJob(jobId).orElseThrow(() ->
            new ProcessingLifecycleConflictException("Unknown offline processing job."));
        if (!"OFFLINE_MEETING_PROCESSING".equals(job.jobType()))
            throw new ProcessingLifecycleConflictException("Not an offline processing job.");
        if (!List.of("PENDING","QUEUED","RUNNING").contains(job.status()))
            throw new ProcessingLifecycleConflictException("Offline processing job is not active.");
        if (pinned(jobId)) return;
        if (evidence.latestSuccessfulFinalization(jobId).isEmpty())
            throw new ProcessingLifecycleConflictException(
                "A committed finalized transcript is required for offline snapshot preparation.");

        var source=capture.capture(job.meetingId());
        if (!job.id().equals(source.originJobId())
                || !job.sourceMediaId().equals(source.mediaId()))
            throw new ProcessingLifecycleConflictException(
                "Current transcript does not belong to the offline processing job.");

        UUID snapshotId=UUID.randomUUID();
        var stored=store.put(jobId,snapshotId,source.bytes());
        boolean accepted=false;
        try {
            accepted=persistence.persist(jobId,job.meetingId(),job.sourceMediaId(),
                snapshotId,source,stored);
        } finally {
            // The same-source concurrent winner retains its own key.
            // The losing attempt and any failed DB admission clean theirs.
            if (!accepted) store.cleanup(stored.key());
        }
    }

    private boolean pinned(UUID jobId) {
        return Boolean.TRUE.equals(jdbc.queryForObject("""
            SELECT EXISTS(SELECT 1 FROM meeting_intelligence_source_snapshots
              WHERE processing_job_id=?)
            """,Boolean.class,jobId));
    }
}
