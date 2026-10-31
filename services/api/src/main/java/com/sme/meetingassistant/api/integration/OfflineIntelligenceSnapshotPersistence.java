package com.sme.meetingassistant.api.integration;

import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.repository.MediaRepository.ProcessingLifecycleConflictException;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceSnapshotStore;
import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository.TranscriptSource;
import com.sme.meetingassistant.api.transcript.service.TranscriptSnapshotCapture.Captured;
import com.sme.meetingassistant.api.transcript.service.TranscriptSourceGuard;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Only binds externally verified immutable bytes after source/owner recheck. */
@Service
public class OfflineIntelligenceSnapshotPersistence {
    private final JdbcTemplate jdbc;
    private final MediaRepository media;
    private final TranscriptSourceGuard transcripts;

    public OfflineIntelligenceSnapshotPersistence(JdbcTemplate jdbc,MediaRepository media,
            TranscriptSourceGuard transcripts) {
        this.jdbc=jdbc;this.media=media;this.transcripts=transcripts;
    }

    @Transactional
    public boolean persist(UUID jobId,UUID meetingId,UUID mediaId,
            UUID snapshotId,Captured source,IntelligenceSnapshotStore.Snapshot stored) {
        // Same Meeting-first lock order as review, result ingestion and Summary edits.
        transcripts.requireCurrentForDerivedWrite(meetingId,
            new TranscriptSource(source.transcriptId(),source.contentRevision(),source.status()));
        var job=media.findJob(jobId).orElseThrow(() ->
            new ProcessingLifecycleConflictException("Offline source job disappeared."));
        if (!meetingId.equals(job.meetingId()) || !mediaId.equals(job.sourceMediaId())
                || !jobId.equals(source.originJobId()) || !mediaId.equals(source.mediaId())
                || !"OFFLINE_MEETING_PROCESSING".equals(job.jobType())
                || !List.of("PENDING","QUEUED","RUNNING").contains(job.status())) {
            throw new ProcessingLifecycleConflictException(
                "Offline job changed before snapshot source admission.");
        }
        Boolean exists=jdbc.queryForObject("""
            SELECT EXISTS(SELECT 1 FROM meeting_intelligence_source_snapshots
              WHERE processing_job_id=?)
            """,Boolean.class,jobId);
        if (Boolean.TRUE.equals(exists)) return false;
        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(
                id,meeting_id,source_media_id,processing_job_id,transcript_id,
                content_revision,sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,?,?,?,?)
            """,snapshotId,meetingId,mediaId,jobId,source.transcriptId(),
            source.contentRevision(),stored.sha256(),stored.key(),stored.sizeBytes());
        return true;
    }
}
