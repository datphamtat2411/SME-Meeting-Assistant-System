package com.sme.meetingassistant.api.meetingintelligence.service;

import com.sme.meetingassistant.api.audit.TransactionalAuditWriter;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Short PostgreSQL validation/audit transactions. No S3 call may execute while
 * the Meeting -> Media-job row locks are held. An existing canonical reference
 * always wins, even for old/terminal jobs.
 */
@Service
public class IntelligenceOrphanCleanupAudit {
    private final JdbcTemplate jdbc;
    private final TransactionalAuditWriter writer;

    public IntelligenceOrphanCleanupAudit(JdbcTemplate jdbc,TransactionalAuditWriter writer) {
        this.jdbc=jdbc;this.writer=writer;
    }

    public record Job(UUID id,UUID meetingId) { }

    @Transactional(readOnly=true)
    public java.util.List<Job> eligibleJobs(Instant cutoff,int max) {
        return jdbc.query("""
            SELECT j.id,j.meeting_id
            FROM processing_jobs j
            WHERE j.status IN ('COMPLETED','COMPLETED_WITH_WARNINGS','FAILED')
              AND j.updated_at < ?
              AND NOT EXISTS (SELECT 1 FROM processing_stage_runs s
                  WHERE s.processing_job_id=j.id AND s.status IN ('RUNNING','PENDING'))
              AND NOT EXISTS (SELECT 1 FROM audit_events a
                  WHERE a.entity_type='PROCESSING_JOB'
                    AND a.entity_id=j.id AND a.action_code='MI_STORAGE_ORPHAN_SCAN'
                    AND a.occurred_at > clock_timestamp() - INTERVAL '12 hours')
            ORDER BY j.updated_at,j.id LIMIT ?
            """,(rs,n)->new Job(rs.getObject("id",UUID.class),
                rs.getObject("meeting_id",UUID.class)),
            OffsetDateTime.ofInstant(cutoff,java.time.ZoneOffset.UTC),max);
    }

    /**
     * Atomic cross-replica claim before any object-store I/O.
     * A crashed runner may be reclaimed after a two-hour lease; a completed
     * scan is not reprocessed for twelve hours.
     */
    @Transactional
    public boolean claim(UUID jobId,UUID meetingId,UUID token,Instant cutoff) {
        var meetings=jdbc.query("SELECT id FROM meetings WHERE id=? FOR UPDATE",
            (rs,n)->rs.getObject(1,UUID.class),meetingId);
        if(meetings.size()!=1) return false;
        var jobs=jdbc.query("""
            SELECT status,updated_at FROM processing_jobs
            WHERE id=? AND meeting_id=? FOR UPDATE
            """,(rs,n)->new JobState(rs.getString(1),
                rs.getObject(2,OffsetDateTime.class)),jobId,meetingId);
        if(jobs.size()!=1) return false;
        var state=jobs.getFirst();
        if(!java.util.List.of("COMPLETED","COMPLETED_WITH_WARNINGS","FAILED")
                .contains(state.status()) || !state.updatedAt().toInstant().isBefore(cutoff))
            return false;
        Boolean active=jdbc.queryForObject("""
            SELECT EXISTS(SELECT 1 FROM processing_stage_runs
                WHERE processing_job_id=? AND status IN ('RUNNING','PENDING'))
            """,Boolean.class,jobId);
        if(Boolean.TRUE.equals(active)) return false;
        var acquired=jdbc.query("""
            INSERT INTO meeting_intelligence_orphan_scan_claims(
                processing_job_id,claim_token,updated_at,lease_expires_at)
            VALUES (?,?,clock_timestamp(),clock_timestamp()+INTERVAL '2 hours')
            ON CONFLICT (processing_job_id) DO UPDATE SET
                claim_token=EXCLUDED.claim_token,
                updated_at=clock_timestamp(),
                lease_expires_at=clock_timestamp()+INTERVAL '2 hours'
            WHERE meeting_intelligence_orphan_scan_claims.lease_expires_at < clock_timestamp()
              AND (meeting_intelligence_orphan_scan_claims.last_completed_at IS NULL
                   OR meeting_intelligence_orphan_scan_claims.last_completed_at
                        < clock_timestamp()-INTERVAL '12 hours')
            RETURNING processing_job_id
            """,(rs,n)->rs.getObject(1,UUID.class),jobId,token);
        return acquired.size()==1;
    }

    @Transactional
    public boolean authorize(UUID jobId,UUID meetingId,String key,String kind,
            Instant cutoff,boolean dryRun) {
        var meeting=jdbc.query("SELECT id FROM meetings WHERE id=? FOR UPDATE",
            (rs,n)->rs.getObject(1,UUID.class),meetingId);
        if(meeting.size()!=1) return false;
        var jobs=jdbc.query("""
            SELECT status,updated_at FROM processing_jobs
            WHERE id=? AND meeting_id=? FOR UPDATE
            """,(rs,n)->new JobState(rs.getString(1),
                rs.getObject(2,OffsetDateTime.class)),jobId,meetingId);
        if(jobs.size()!=1) return false;
        var state=jobs.getFirst();
        if(!java.util.List.of("COMPLETED","COMPLETED_WITH_WARNINGS","FAILED")
                .contains(state.status()) || !state.updatedAt().toInstant().isBefore(cutoff))
            return false;
        Boolean live=jdbc.queryForObject("""
            SELECT EXISTS(SELECT 1 FROM processing_stage_runs
              WHERE processing_job_id=? AND status IN ('RUNNING','PENDING'))
            """,Boolean.class,jobId);
        if(Boolean.TRUE.equals(live)) return false;
        Boolean used=jdbc.queryForObject("""
            SELECT EXISTS(
              SELECT 1 FROM meeting_intelligence_source_snapshots
                WHERE processing_job_id=? AND object_key=?
              UNION ALL
              SELECT 1 FROM meeting_intelligence_result_receipts
                WHERE processing_job_id=? AND artifact_object_key=?
              UNION ALL
              SELECT 1 FROM processing_artifacts
                WHERE object_key=?
            )
            """,Boolean.class,jobId,key,jobId,key,key);
        if(Boolean.TRUE.equals(used)) return false;
        writer.recordService(dryRun?"MI_STORAGE_ORPHAN_DRY_RUN":"MI_STORAGE_ORPHAN_DELETE_INTENT",
            "PROCESSING_JOB",jobId,meetingId,
            Map.of("schemaVersion",1,"keySha256",hash(key),"kind",kind));
        return true;
    }

    @Transactional
    public void outcome(UUID jobId,UUID meetingId,String key,String kind,boolean deleted) {
        writer.recordService(deleted?"MI_STORAGE_ORPHAN_DELETED":"MI_STORAGE_ORPHAN_DELETE_FAILED",
            "PROCESSING_JOB",jobId,meetingId,
            Map.of("schemaVersion",1,"keySha256",hash(key),"kind",kind));
    }

    @Transactional
    public void scanned(UUID jobId,UUID meetingId,UUID token,int inspected,
            int eligible,int deleted,boolean truncated) {
        int completed=jdbc.update("""
            UPDATE meeting_intelligence_orphan_scan_claims
               SET last_completed_at=clock_timestamp(),
                   lease_expires_at=clock_timestamp(),
                   updated_at=clock_timestamp()
             WHERE processing_job_id=? AND claim_token=?
               AND lease_expires_at>clock_timestamp()
            """,jobId,token);
        if(completed!=1)
            throw new IllegalStateException("Orphan scan claim expired or was superseded.");
        writer.recordService("MI_STORAGE_ORPHAN_SCAN","PROCESSING_JOB",jobId,meetingId,
            Map.of("schemaVersion",1,"inspected",inspected,"eligible",eligible,
                "deleted",deleted,"truncated",truncated));
    }

    private static String hash(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch(NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable.",e);
        }
    }
    private record JobState(String status,OffsetDateTime updatedAt) { }
}
