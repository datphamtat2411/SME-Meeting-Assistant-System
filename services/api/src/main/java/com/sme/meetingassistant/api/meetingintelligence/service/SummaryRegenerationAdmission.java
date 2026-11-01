package com.sme.meetingassistant.api.meetingintelligence.service;

import com.sme.meetingassistant.api.media.service.DerivedSummaryJobAdmission;
import com.sme.meetingassistant.api.transcript.service.TranscriptSnapshotCapture.Captured;
import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository.TranscriptSource;
import com.sme.meetingassistant.api.transcript.service.TranscriptSourceGuard;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * One PostgreSQL transaction across Media job, MI snapshot and durable outbox.
 * User lock precedes meeting/source lock; no network/S3 I/O in this transaction.
 */
@Service
public class SummaryRegenerationAdmission {
    private final DerivedSummaryJobAdmission media;
    private final TranscriptSourceGuard transcripts;
    private final JdbcTemplate jdbc;
    private final MeetingIntelligenceAudit audit;
    private final MeetingIntelligenceMetrics metrics;

    public SummaryRegenerationAdmission(DerivedSummaryJobAdmission media,
            TranscriptSourceGuard transcripts, JdbcTemplate jdbc,
            MeetingIntelligenceAudit audit, MeetingIntelligenceMetrics metrics) {
        this.media=media;
        this.transcripts=transcripts;
        this.jdbc=jdbc;
        this.audit=audit;
        this.metrics=metrics;
    }

    @Transactional
    public Result persist(UUID meetingId, UUID actor, String idempotencyKey,
            UUID jobId, UUID snapshotId, Captured source,
            IntelligenceSnapshotStore.Snapshot stored) {
        media.lockRequester(actor);
        var existing=media.existing(actor, meetingId, idempotencyKey);
        if (existing.isPresent()) return new Result(existing.get(),false);

        // Recheck after storage I/O while holding the meeting row lock. A
        // review/republish between capture and admission cannot queue stale bytes.
        transcripts.requireCurrentForDerivedWrite(meetingId,
            new TranscriptSource(source.transcriptId(),source.contentRevision(),source.status()));
        var admitted=media.admit(actor,meetingId,source.mediaId(),source.originJobId(),
            jobId,idempotencyKey);
        if (!admitted.created()) return new Result(admitted.jobId(),false);
        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(
                id,meeting_id,source_media_id,processing_job_id,transcript_id,
                content_revision,sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,?,?,?,?)
            """,snapshotId,meetingId,source.mediaId(),jobId,source.transcriptId(),
            source.contentRevision(),stored.sha256(),stored.key(),stored.sizeBytes());
        audit.regenerationRequested(actor,meetingId,jobId,
            source.transcriptId(),source.contentRevision());
        metrics.committed("summary_regeneration", "ACCEPTED");
        return new Result(jobId,true);
    }
    public record Result(UUID jobId,boolean created) { }
}
