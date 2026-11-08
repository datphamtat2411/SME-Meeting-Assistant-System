package com.sme.meetingassistant.api.meetingexport;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Durable observation ledger and bounded scan cursor. Every transition uses
 * database-clock predicates; no cross-database/S3 distributed transaction.
 */
@Repository
public final class ExportOrphanRepository {
    private final JdbcTemplate jdbc;

    public ExportOrphanRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record ScanLease(UUID token, String cursor) { }
    public record Candidate(String objectKey, UUID exportId, String etag,
            long size, OffsetDateTime lastModified) { }

    public Optional<ScanLease> acquireScan() {
        UUID token = UUID.randomUUID();
        var rows = jdbc.query("""
            UPDATE meeting_export_reconciliation_cursor
               SET lease_token=?,lease_expires_at=clock_timestamp()+INTERVAL '5 minutes',
                   updated_at=clock_timestamp()
             WHERE id=1 AND (lease_expires_at IS NULL
                             OR lease_expires_at<clock_timestamp())
            RETURNING continuation_token
            """, (rs, n) -> new ScanLease(token, rs.getString(1)), token);
        return rows.stream().findFirst();
    }

    public boolean finishScan(UUID token, String nextToken) {
        return jdbc.update("""
            UPDATE meeting_export_reconciliation_cursor
               SET continuation_token=?,lease_token=NULL,lease_expires_at=NULL,
                   updated_at=clock_timestamp()
             WHERE id=1 AND lease_token=? AND lease_expires_at>clock_timestamp()
            """, nextToken, token) == 1;
    }

    public void abandonScan(UUID token) {
        jdbc.update("""
            UPDATE meeting_export_reconciliation_cursor
               SET lease_token=NULL,lease_expires_at=NULL,
                   updated_at=clock_timestamp()
             WHERE id=1 AND lease_token=?
            """, token);
    }

    /**
     * Extra-conservative orphan classification: never collect ANY byte object
     * under an export UUID that still has a committed export intent, even when
     * the object is not the current snapshot/artifact key. This protects
     * FAILED retries, admission intake and historical READY artifacts.
     */
    public boolean hasCommittedExportReference(UUID exportId, String objectKey) {
        return Boolean.TRUE.equals(jdbc.queryForObject("""
            SELECT
                EXISTS(SELECT 1 FROM meeting_exports e
                        WHERE e.id=? OR e.object_key=? OR e.snapshot_object_key=?)
             OR EXISTS(SELECT 1 FROM meeting_export_intakes i
                        WHERE i.export_id=? OR i.object_key=?)
            """, Boolean.class, exportId, objectKey, objectKey, exportId, objectKey));
    }

    public void markReferenced(String objectKey) {
        jdbc.update("""
            UPDATE meeting_export_orphan_candidates
               SET status='SKIPPED_REFERENCE',last_error_code=NULL
             WHERE object_key=? AND status='OBSERVED'
            """, objectKey);
    }

    public void observe(String key, UUID exportId, Instant lastModified,
            String etag, long size) {
        OffsetDateTime modifiedAt = OffsetDateTime.ofInstant(lastModified, ZoneOffset.UTC);
        jdbc.update("""
            INSERT INTO meeting_export_orphan_candidates (
                object_key,export_id,object_last_modified,observed_etag,
                observed_size_bytes)
            VALUES(?,?,?,?,?)
            ON CONFLICT (object_key) DO UPDATE SET
                first_observed_at=CASE WHEN
                    meeting_export_orphan_candidates.object_last_modified = EXCLUDED.object_last_modified
                    AND meeting_export_orphan_candidates.observed_etag = EXCLUDED.observed_etag
                    AND meeting_export_orphan_candidates.observed_size_bytes = EXCLUDED.observed_size_bytes
                    THEN meeting_export_orphan_candidates.first_observed_at
                    ELSE clock_timestamp() END,
                observation_count=CASE WHEN
                    meeting_export_orphan_candidates.object_last_modified = EXCLUDED.object_last_modified
                    AND meeting_export_orphan_candidates.observed_etag = EXCLUDED.observed_etag
                    AND meeting_export_orphan_candidates.observed_size_bytes = EXCLUDED.observed_size_bytes
                    THEN meeting_export_orphan_candidates.observation_count + 1
                    ELSE 1 END,
                status=CASE WHEN
                    meeting_export_orphan_candidates.object_last_modified = EXCLUDED.object_last_modified
                    AND meeting_export_orphan_candidates.observed_etag = EXCLUDED.observed_etag
                    AND meeting_export_orphan_candidates.observed_size_bytes = EXCLUDED.observed_size_bytes
                    THEN meeting_export_orphan_candidates.status
                    ELSE 'OBSERVED' END,
                claim_token=NULL,
                lease_expires_at=NULL,
                purged_at=CASE WHEN
                    meeting_export_orphan_candidates.object_last_modified = EXCLUDED.object_last_modified
                    AND meeting_export_orphan_candidates.observed_etag = EXCLUDED.observed_etag
                    AND meeting_export_orphan_candidates.observed_size_bytes = EXCLUDED.observed_size_bytes
                    THEN meeting_export_orphan_candidates.purged_at
                    ELSE NULL END,
                next_attempt_at=NULL,
                last_error_code=NULL,
                object_last_modified=EXCLUDED.object_last_modified,
                observed_etag=EXCLUDED.observed_etag,
                observed_size_bytes=EXCLUDED.observed_size_bytes,
                last_observed_at=clock_timestamp()
            WHERE meeting_export_orphan_candidates.status <> 'DELETING'
            """, key, exportId, modifiedAt, etag, size);
    }

    public void recoverExpiredClaims() {
        jdbc.update("""
            UPDATE meeting_export_orphan_candidates
               SET status='OBSERVED',claim_token=NULL,lease_expires_at=NULL,
                   next_attempt_at=clock_timestamp()+INTERVAL '1 hour',
                   last_error_code='CLAIM_EXPIRED'
             WHERE status='DELETING' AND lease_expires_at<clock_timestamp()
            """);
    }

    public List<Candidate> eligible(int minimumAgeHours, int quarantineHours, int limit) {
        return jdbc.query("""
            SELECT object_key,export_id,observed_etag,observed_size_bytes,
                   object_last_modified
              FROM meeting_export_orphan_candidates
             WHERE status='OBSERVED'
               AND observation_count>=2
               AND object_last_modified<=clock_timestamp() - (? * INTERVAL '1 hour')
               AND first_observed_at<=clock_timestamp() - (? * INTERVAL '1 hour')
               AND last_observed_at>=clock_timestamp() - INTERVAL '7 days'
               AND (next_attempt_at IS NULL OR next_attempt_at<clock_timestamp())
             ORDER BY first_observed_at,object_key LIMIT ?
            """, (rs, n) -> new Candidate(rs.getString(1),
                    rs.getObject(2,UUID.class),rs.getString(3),rs.getLong(4),
                    rs.getObject(5,OffsetDateTime.class)),
                minimumAgeHours,quarantineHours,limit);
    }

    public boolean claim(Candidate c, UUID token, int minAgeHours, int quarantineHours) {
        return jdbc.update("""
            UPDATE meeting_export_orphan_candidates
               SET status='DELETING',claim_token=?,
                   lease_expires_at=clock_timestamp()+INTERVAL '5 minutes'
             WHERE object_key=? AND export_id=? AND status='OBSERVED'
               AND observed_etag=? AND observed_size_bytes=?
               AND object_last_modified=?
               AND observation_count>=2
               AND object_last_modified<=clock_timestamp() - (? * INTERVAL '1 hour')
               AND first_observed_at<=clock_timestamp() - (? * INTERVAL '1 hour')
               AND (next_attempt_at IS NULL OR next_attempt_at<clock_timestamp())
            """, token,c.objectKey(),c.exportId(),c.etag(),c.size(),
                c.lastModified(),minAgeHours,quarantineHours) == 1;
    }

    public void finishPurged(String key, UUID token) {
        jdbc.update("""
            UPDATE meeting_export_orphan_candidates
               SET status='PURGED',claim_token=NULL,lease_expires_at=NULL,
                   purged_at=clock_timestamp(),last_error_code=NULL
             WHERE object_key=? AND status='DELETING' AND claim_token=?
                   AND lease_expires_at>clock_timestamp()
            """, key, token);
    }

    public void releaseClaim(String key, UUID token, String safeCode) {
        ExportDigests.requireRenderer(safeCode);
        jdbc.update("""
            UPDATE meeting_export_orphan_candidates
               SET status='OBSERVED',claim_token=NULL,lease_expires_at=NULL,
                   last_error_code=?,next_attempt_at=clock_timestamp()+INTERVAL '1 hour'
             WHERE object_key=? AND status='DELETING' AND claim_token=?
            """, safeCode,key,token);
    }

    public void protectReferenced(String key, UUID token) {
        jdbc.update("""
            UPDATE meeting_export_orphan_candidates
               SET status='SKIPPED_REFERENCE',claim_token=NULL,
                   lease_expires_at=NULL,last_error_code=NULL
             WHERE object_key=? AND status='DELETING' AND claim_token=?
            """, key,token);
    }
}
