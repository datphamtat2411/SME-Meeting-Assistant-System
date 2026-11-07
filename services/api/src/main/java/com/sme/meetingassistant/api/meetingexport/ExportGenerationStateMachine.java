package com.sme.meetingassistant.api.meetingexport;

import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * DE-06 durable transition boundary, NOT an active background worker.
 *
 * DE-09 owns worker scheduling/retry policy; DE-10 owns private S3 proof and
 * capability issuance. No controller exposes these methods to external users.
 *
 * A claim token is an unguessable *internal fencing credential*. The UPDATE
 * predicates always check current token and DB server lease time, preventing
 * a late worker from publishing READY after a newer attempt.
 */
@Service
public class ExportGenerationStateMachine {
    private static final Pattern FAILURE = Pattern.compile("[A-Z][A-Z0-9_]{0,95}");
    private final JdbcTemplate jdbc;
    private final MeetingExportRepository repository;
    private final int minimumLeaseSeconds;

    public ExportGenerationStateMachine(JdbcTemplate jdbc, MeetingExportRepository repository,
            @Value("${app.exports.minimum-lease-seconds:30}") int minimumLeaseSeconds) {
        if (minimumLeaseSeconds < 1 || minimumLeaseSeconds > 900) {
            throw new IllegalArgumentException("Invalid export minimum lease");
        }
        this.jdbc = jdbc;
        this.repository = repository;
        this.minimumLeaseSeconds = minimumLeaseSeconds;
    }

    /** One atomic PostgreSQL claim. SKIP LOCKED supports concurrent nodes. */
    @Transactional
    public Optional<ExportRecord> claimNext(int leaseSeconds) {
        requireLease(leaseSeconds);
        UUID token = UUID.randomUUID();
        List<UUID> claimed = jdbc.query("""
            WITH candidate AS (
                SELECT id FROM meeting_exports WHERE status='PENDING'
                 ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
            )
            UPDATE meeting_exports e
               SET status='GENERATING',claim_token=?,generation_attempt=e.generation_attempt+1,
                   lease_expires_at=clock_timestamp() + (? * INTERVAL '1 second'),
                   row_version=e.row_version+1
              FROM candidate
             WHERE e.id=candidate.id
            RETURNING e.id
            """, (rs, ignored) -> rs.getObject(1, UUID.class), token, leaseSeconds);
        return claimed.isEmpty() ? Optional.empty() : repository.find(claimed.getFirst());
    }

    /**
     * DE-09 production dispatch: only fully staged immutable intakes may run.
     * Kept distinct from DE-06 claimNext so historical state-machine tests can
     * exercise raw PENDING intents without fabricating an S3 intake.
     */
    @Transactional
    public Optional<ExportRecord> claimNextStaged(int leaseSeconds) {
        requireLease(leaseSeconds);
        UUID token = UUID.randomUUID();
        List<UUID> claimed = jdbc.query("""
            WITH candidate AS (
                SELECT e.id FROM meeting_exports e
                  JOIN meeting_export_intakes i ON i.export_id=e.id
                 WHERE e.status='PENDING'
                 ORDER BY e.created_at,e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED
            )
            UPDATE meeting_exports e
               SET status='GENERATING',claim_token=?,
                   generation_attempt=e.generation_attempt+1,
                   lease_expires_at=clock_timestamp() + (? * INTERVAL '1 second'),
                   row_version=e.row_version+1
              FROM candidate WHERE e.id=candidate.id
            RETURNING e.id
            """, (rs, ignored) -> rs.getObject(1, UUID.class), token, leaseSeconds);
        return claimed.isEmpty() ? Optional.empty() : repository.find(claimed.getFirst());
    }

    /** Heartbeat may only extend a live claim; it never transfers ownership. */
    @Transactional
    public boolean renew(UUID exportId, UUID claimToken, int leaseSeconds) {
        requireLease(leaseSeconds);
        return jdbc.update("""
            UPDATE meeting_exports
               SET lease_expires_at=clock_timestamp() + (? * INTERVAL '1 second'),
                   row_version=row_version+1
             WHERE id=? AND status='GENERATING' AND claim_token=?
               AND lease_expires_at>clock_timestamp()
               AND clock_timestamp() + (? * INTERVAL '1 second') > lease_expires_at
            """, leaseSeconds, exportId, claimToken, leaseSeconds) == 1;
    }

    /**
     * The snapshot bytes MUST already be persisted privately by the
     * DE-09/10 worker before it pins this immutable source pointer.
     */
    @Transactional
    public boolean pinSnapshot(UUID exportId, UUID claimToken,
            String fingerprint, String rendererVersion) {
        String digest = ExportDigests.requireDigest(fingerprint);
        String renderer = ExportDigests.requireRenderer(rendererVersion);
        String key = ExportDigests.snapshotKey(exportId, digest);
        return jdbc.update("""
            UPDATE meeting_exports
               SET source_fingerprint=?,snapshot_object_key=?,renderer_version=?,
                   row_version=row_version+1
             WHERE id=? AND status='GENERATING' AND claim_token=?
               AND lease_expires_at>clock_timestamp()
               AND source_fingerprint IS NULL AND snapshot_object_key IS NULL
            """, digest, key, renderer, exportId, claimToken) == 1;
    }

    /**
     * Commit only after DE-10 storage confirms the immutable object digest and
     * size. DE-06 persists the proof; it cannot perform S3 verification.
     * No alternate render/overwrite path exists for an immutable READY export.
     */
    @Transactional
    public boolean publishReady(UUID exportId, UUID claimToken,
            String artifactSha256, long artifactSizeBytes) {
        String digest = ExportDigests.requireDigest(artifactSha256);
        if (artifactSizeBytes < 1) throw new IllegalArgumentException("Artifact must be nonempty");
        return jdbc.update("""
            UPDATE meeting_exports
               SET status='READY',
                   object_key='exports/' || id::text || '/artifacts/' || ? ||
                       CASE WHEN format='PDF' THEN '.pdf' ELSE '.md' END,
                   artifact_sha256=?,artifact_size_bytes=?,ready_at=clock_timestamp(),
                   claim_token=NULL,lease_expires_at=NULL,row_version=row_version+1
             WHERE id=? AND status='GENERATING' AND claim_token=?
               AND lease_expires_at>clock_timestamp()
               AND source_fingerprint IS NOT NULL AND snapshot_object_key IS NOT NULL
               AND renderer_version IS NOT NULL
            """, digest, digest, artifactSizeBytes, exportId, claimToken) == 1;
    }

    /** No provider message or raw AI text: persist a bounded safe error code. */
    @Transactional
    public boolean fail(UUID exportId, UUID claimToken, String safeCode) {
        if (safeCode == null || !FAILURE.matcher(safeCode).matches()) {
            throw new IllegalArgumentException("Failure code must be safe and bounded");
        }
        return jdbc.update("""
            UPDATE meeting_exports
               SET status='FAILED',last_error_code=?,claim_token=NULL,
                   lease_expires_at=NULL,row_version=row_version+1
             WHERE id=? AND status='GENERATING' AND claim_token=?
               AND lease_expires_at>clock_timestamp()
            """, safeCode, exportId, claimToken) == 1;
    }

    /** Expired attempts become FAILED; never silently rendered as READY. */
    @Transactional
    public int failExpired(int limit) {
        if (limit < 1 || limit > 500) throw new IllegalArgumentException("Invalid sweep limit");
        return jdbc.update("""
            WITH abandoned AS (
                SELECT id FROM meeting_exports
                 WHERE status='GENERATING' AND lease_expires_at<=clock_timestamp()
                 ORDER BY lease_expires_at,id LIMIT ? FOR UPDATE SKIP LOCKED
            )
            UPDATE meeting_exports e
               SET status='FAILED',last_error_code='EXPORT_LEASE_EXPIRED',
                   claim_token=NULL,lease_expires_at=NULL,row_version=e.row_version+1
              FROM abandoned
             WHERE e.id=abandoned.id AND e.status='GENERATING'
            """, limit);
    }

    /**
     * Only a policy-authorized orchestrator may explicitly retry FAILED.
     * Each retry loses the old source pin; it requires a fresh artifact proof.
     * There is NO automatic retry loop or public HTTP route in DE-06.
     */
    @Transactional
    public boolean requeueFailed(UUID exportId) {
        return jdbc.update("""
            UPDATE meeting_exports
               SET status='PENDING',last_error_code=NULL,
                   source_fingerprint=NULL,snapshot_object_key=NULL,
                   renderer_version=NULL,row_version=row_version+1
             WHERE id=? AND status='FAILED'
            """, exportId) == 1;
    }

    private void requireLease(int seconds) {
        if (seconds < minimumLeaseSeconds || seconds > 900) {
            throw new IllegalArgumentException("Lease must respect configured minimum and 900-second cap");
        }
    }
}
