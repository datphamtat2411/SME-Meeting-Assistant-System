package com.sme.meetingassistant.api.media.repository;

import com.sme.meetingassistant.api.observability.RequestIdContext;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;

@Repository
public class MediaRepository {
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public MediaRepository(JdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    public void insertMedia(Media media) {
        this.jdbc.update("""
            INSERT INTO meeting_media (id, meeting_id, source_type, status, object_key, original_filename,
              content_type, expected_size_bytes, uploaded_by_user_id, pending_object_key, created_at)
            VALUES (?, ?, ?, 'PENDING_UPLOAD', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            """, media.id(), media.meetingId(), media.sourceType(), media.objectKey(), media.originalFilename(),
            media.contentType(), media.expectedSizeBytes(), media.uploadedBy(), media.objectKey());
    }

    public Optional<Media> findMedia(UUID id) {
        return this.jdbc.query("SELECT * FROM meeting_media WHERE id = ?", MediaRepository::mediaRow, id)
            .stream().findFirst();
    }

    public List<Media> listMedia(UUID meetingId) {
        return this.jdbc.query("SELECT * FROM meeting_media WHERE meeting_id = ? ORDER BY created_at DESC, id",
            MediaRepository::mediaRow, meetingId);
    }

    /**
     * Fences finalization without keeping a transaction open while the service probes/uploads bytes.
     * Expired claim holders can never publish AVAILABLE using a stale lease token.
     */
    public boolean claimFinalization(UUID mediaId, UUID token, long leaseSeconds) {
        return this.jdbc.update("""
            UPDATE meeting_media SET finalization_token = ?,
              finalization_lease_until = CURRENT_TIMESTAMP + (? * INTERVAL '1 second')
            WHERE id = ? AND status = 'PENDING_UPLOAD' AND
              (finalization_token IS NULL OR finalization_lease_until < CURRENT_TIMESTAMP)
            """, token, leaseSeconds, mediaId) == 1;
    }

    public void releaseFinalization(UUID mediaId, UUID token) {
        this.jdbc.update("""
            UPDATE meeting_media SET finalization_token = NULL, finalization_lease_until = NULL
            WHERE id = ? AND status = 'PENDING_UPLOAD' AND finalization_token = ?
            """, mediaId, token);
    }

    public boolean acceptMedia(UUID id, UUID token, String acceptedKey,
            long sizeBytes, long durationMs, String sha256) {
        return this.jdbc.update("""
            UPDATE meeting_media SET status = 'AVAILABLE', object_key = ?,
              size_bytes = ?, duration_ms = ?, sha256 = ?,
              available_at = CURRENT_TIMESTAMP, failure_code = NULL,
              finalization_token = NULL, finalization_lease_until = NULL
            WHERE id = ? AND status = 'PENDING_UPLOAD' AND finalization_token = ?
              AND finalization_lease_until > CURRENT_TIMESTAMP
            """, acceptedKey, sizeBytes, durationMs, sha256, id, token) == 1;
    }

    public boolean rejectMedia(UUID id, UUID token, String code) {
        return this.jdbc.update("""
            UPDATE meeting_media SET status = 'REJECTED', failure_code = ?,
              finalization_token = NULL, finalization_lease_until = NULL
            WHERE id = ? AND status = 'PENDING_UPLOAD' AND finalization_token = ?
              AND finalization_lease_until > CURRENT_TIMESTAMP
            """, code, id, token) == 1;
    }

    /** Expired uploads are terminal; they can never race a valid finalization claim. */
    public void expireOldUploads(long expirySeconds, int limit) {
        this.jdbc.update("""
            UPDATE meeting_media SET status = 'FAILED', failure_code = 'UPLOAD_EXPIRED'
            WHERE id IN (
              SELECT id FROM meeting_media
              WHERE status = 'PENDING_UPLOAD'
                AND created_at < CURRENT_TIMESTAMP - (? * INTERVAL '1 second')
                AND (finalization_token IS NULL OR finalization_lease_until < CURRENT_TIMESTAMP)
              ORDER BY created_at, id LIMIT ? FOR UPDATE SKIP LOCKED
            )
            """, expirySeconds, limit);
    }

    public List<PendingCleanup> pendingCleanupCandidates(long retentionSeconds, int limit) {
        return this.jdbc.query("""
            SELECT id, pending_object_key FROM meeting_media
            WHERE status IN ('AVAILABLE', 'FAILED', 'REJECTED')
              AND pending_cleaned_at IS NULL
              AND COALESCE(available_at, created_at) < CURRENT_TIMESTAMP - (? * INTERVAL '1 second')
            ORDER BY created_at, id LIMIT ?
            """, (rs, row) -> new PendingCleanup(rs.getObject("id", UUID.class),
                rs.getString("pending_object_key")), retentionSeconds, limit);
    }

    public void markPendingCleaned(UUID id, String pendingKey) {
        this.jdbc.update("""
            UPDATE meeting_media SET pending_cleaned_at = CURRENT_TIMESTAMP
            WHERE id = ? AND pending_object_key = ? AND pending_cleaned_at IS NULL
              AND status IN ('AVAILABLE', 'FAILED', 'REJECTED')
            """, id, pendingKey);
    }

    public UUID claimIdempotency(UUID caller, String operation, String key, String fingerprint, UUID proposedResourceId) {
        this.jdbc.update("""
            INSERT INTO processing_job_idempotency
              (id, requester_id, operation, idempotency_key, request_fingerprint, resource_id)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (requester_id, operation, idempotency_key) DO NOTHING
            """, UUID.randomUUID(), caller, operation, key, fingerprint, proposedResourceId);
        return this.jdbc.query("""
            SELECT resource_id, request_fingerprint FROM processing_job_idempotency
            WHERE requester_id = ? AND operation = ? AND idempotency_key = ?
            """, (rs, row) -> {
                if (!rs.getString("request_fingerprint").equals(fingerprint)) {
                    throw new IdempotencyConflictException();
                }
                return rs.getObject("resource_id", UUID.class);
            }, caller, operation, key).stream().findFirst().orElseThrow(IdempotencyConflictException::new);
    }

    /**
     * Must run inside the caller's transaction. Row-level user locks serialize
     * admissions across API instances without a new distributed lock service.
     */
    public void lockAdmissionUser(UUID userId) {
        this.jdbc.queryForObject("SELECT id FROM users WHERE id = ? FOR NO KEY UPDATE", UUID.class, userId);
    }

    public int activeJobsForMeeting(UUID meetingId) {
        return this.jdbc.queryForObject("""
            SELECT count(*) FROM processing_jobs WHERE meeting_id = ?
              AND status IN ('PENDING', 'QUEUED', 'RUNNING')
            """, Integer.class, meetingId);
    }

    public int initialJobsForSource(UUID sourceMediaId) {
        return this.jdbc.queryForObject("""
            SELECT count(*) FROM processing_jobs WHERE source_media_id = ?
              AND reprocess_of_job_id IS NULL
            """, Integer.class, sourceMediaId);
    }

    public int activeJobsForUser(UUID userId) {
        return this.jdbc.queryForObject("""
            SELECT count(*) FROM processing_jobs WHERE requested_by_user_id = ?
              AND status IN ('PENDING', 'QUEUED', 'RUNNING')
            """, Integer.class, userId);
    }

    public RecentJobAdmissions recentJobAdmissions(UUID userId, int windowMinutes) {
        return this.jdbc.queryForObject("""
            SELECT count(*) AS admitted,
              COALESCE(GREATEST(1,
                CEIL(EXTRACT(EPOCH FROM
                  (MIN(created_at) + (? * INTERVAL '1 minute') - CURRENT_TIMESTAMP)))
              )::bigint, 1) AS retry_after_seconds
            FROM processing_jobs
            WHERE requested_by_user_id = ?
              AND created_at > CURRENT_TIMESTAMP - (? * INTERVAL '1 minute')
            """, (rs, row) -> new RecentJobAdmissions(
                rs.getInt("admitted"), rs.getLong("retry_after_seconds")),
            windowMinutes, userId, windowMinutes);
    }

    public int pendingUploadIntentsForUser(UUID userId) {
        return this.jdbc.queryForObject("""
            SELECT count(*) FROM meeting_media WHERE uploaded_by_user_id = ?
              AND status = 'PENDING_UPLOAD'
              AND created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours'
            """, Integer.class, userId);
    }

    public void insertJobAndOutbox(Job job, UUID eventId) {
        int inserted = this.jdbc.update("""
            INSERT INTO processing_jobs (id, meeting_id, source_media_id, job_type, status,
              requested_by_user_id, queued_at, created_at, updated_at)
            VALUES (?, ?, ?, 'OFFLINE_MEETING_PROCESSING', 'PENDING', ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT DO NOTHING
            """, job.id(), job.meetingId(), job.sourceMediaId(), job.requestedBy());
        if (inserted != 1) throw new JobAdmissionConflictException();
        String payload;
        try {
            payload = this.mapper.writeValueAsString(new JobQueuedEvent(eventId, job.id(), job.meetingId(),
                job.sourceMediaId(), job.requestedBy(), RequestIdContext.currentRequestId(), 1, OffsetDateTime.now()));
        } catch (JacksonException exception) {
            throw new IllegalStateException("Could not serialize processing event", exception);
        }
        this.jdbc.update("""
            INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, occurred_at)
            VALUES (?, 'PROCESSING_JOB', ?, 'PROCESSING_JOB_QUEUED', CAST(? AS jsonb), CURRENT_TIMESTAMP)
            """, eventId, job.id(), payload);
    }

    public Optional<Job> findJob(UUID id) {
        return this.jdbc.query("SELECT * FROM processing_jobs WHERE id = ?", MediaRepository::jobRow, id)
            .stream().findFirst();
    }

    public List<Job> listJobs(UUID meetingId) {
        return this.jdbc.query("SELECT * FROM processing_jobs WHERE meeting_id = ? ORDER BY created_at DESC, id",
            MediaRepository::jobRow, meetingId);
    }

    /**
     * Claim one batch with an atomic PostgreSQL update. SKIP LOCKED coordinates
     * independent API instances, while the lease token fences late confirmations.
     * No database transaction is held while awaiting a RabbitMQ confirm.
     */
    public List<Outbox> claimPendingOutbox(int limit, int leaseSeconds, int maxAttempts) {
        if (limit < 1 || leaseSeconds < 1 || maxAttempts < 1) {
            throw new IllegalArgumentException("Invalid outbox claim limits");
        }
        // A worker may die during its final attempt. Reconcile the outbox and
        // its still-PENDING job atomically; never overwrite consumer progress.
        this.jdbc.queryForObject("""
            WITH exhausted AS (
              UPDATE outbox_events SET status = 'FAILED',
                claim_token = NULL, claim_expires_at = NULL,
                last_error = COALESCE(last_error, 'OUTBOX_CONFIRM_NOT_OBSERVED')
              WHERE status = 'PENDING' AND attempt_count >= ?
                AND (claim_expires_at IS NULL OR claim_expires_at <= CURRENT_TIMESTAMP)
              RETURNING aggregate_id, aggregate_type, event_type
            ), failed_jobs AS (
              UPDATE processing_jobs p SET status = 'FAILED',
                error_code = 'JOB_DISPATCH_FAILED',
                error_summary = 'Processing job dispatch was not confirmed.',
                completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
                version = version + 1
              FROM exhausted e
              WHERE e.aggregate_type = 'PROCESSING_JOB'
                AND e.event_type = 'PROCESSING_JOB_QUEUED'
                AND p.id = e.aggregate_id AND p.status = 'PENDING'
              RETURNING p.id
            ) SELECT count(*) FROM exhausted
            """, Long.class, maxAttempts);
        return this.jdbc.query("""
            WITH candidates AS (
              SELECT id FROM outbox_events
              WHERE status = 'PENDING' AND attempt_count < ?
                AND next_attempt_at <= CURRENT_TIMESTAMP
                AND (claim_expires_at IS NULL OR claim_expires_at <= CURRENT_TIMESTAMP)
              ORDER BY occurred_at, id
              LIMIT ? FOR UPDATE SKIP LOCKED
            )
            UPDATE outbox_events o
            SET claim_token = gen_random_uuid(),
                claim_expires_at = CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),
                attempt_count = o.attempt_count + 1
            FROM candidates c WHERE o.id = c.id
            RETURNING o.id, o.event_type, o.payload::text AS payload,
                      o.attempt_count, o.claim_token
            """, (rs, row) -> new Outbox(rs.getObject("id", UUID.class),
                    rs.getString("event_type"), rs.getString("payload"),
                    rs.getInt("attempt_count"), rs.getObject("claim_token", UUID.class)),
            maxAttempts, limit, leaseSeconds);
    }

    /**
     * Publisher confirm is not a job dispatch until both outbox=PUBLISHED and
     * PENDING->QUEUED commit in one PostgreSQL statement. The lease fences late
     * confirmations; RUNNING/terminal consumer states cannot be downgraded.
     */
    public boolean markPublished(UUID eventId, UUID claimToken) {
        long updated = this.jdbc.queryForObject("""
            WITH published AS (
              UPDATE outbox_events SET status = 'PUBLISHED',
                published_at = CURRENT_TIMESTAMP, last_error = NULL,
                claim_token = NULL, claim_expires_at = NULL
              WHERE id = ? AND claim_token = ? AND status = 'PENDING'
                AND claim_expires_at > CURRENT_TIMESTAMP
              RETURNING aggregate_id, aggregate_type, event_type
            ), queued_jobs AS (
              UPDATE processing_jobs p SET status = 'QUEUED',
                queued_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
                version = version + 1
              FROM published e
              WHERE e.aggregate_type = 'PROCESSING_JOB'
                AND e.event_type = 'PROCESSING_JOB_QUEUED'
                AND p.id = e.aggregate_id AND p.status = 'PENDING'
              RETURNING p.id
            ) SELECT count(*) FROM published
            """, Long.class, eventId, claimToken);
        return updated == 1;
    }

    /**
     * On retry exhaustion, atomically fail the outbox and its still-PENDING
     * job. Keep error details generic; do not expose broker internal messages.
     */
    public boolean markPublishFailed(UUID eventId, UUID claimToken,
            int attemptCount, int maxAttempts, String error) {
        if (attemptCount < 1 || maxAttempts < 1) {
            throw new IllegalArgumentException("Invalid outbox attempt");
        }
        long delaySeconds = Math.min(300L, 1L << Math.min(attemptCount - 1, 8));
        String safeError = error == null ? "UNKNOWN" : error.substring(0, Math.min(error.length(), 1000));
        long updated = this.jdbc.queryForObject("""
            WITH decided AS (
              UPDATE outbox_events SET status = CASE WHEN attempt_count >= ? THEN 'FAILED'
                                                     ELSE 'PENDING' END,
                last_error = ?, next_attempt_at = CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),
                claim_token = NULL, claim_expires_at = NULL
              WHERE id = ? AND claim_token = ? AND status = 'PENDING'
                AND attempt_count = ? AND claim_expires_at > CURRENT_TIMESTAMP
              RETURNING aggregate_id, aggregate_type, event_type, status
            ), failed_jobs AS (
              UPDATE processing_jobs p SET status = 'FAILED',
                error_code = 'JOB_DISPATCH_FAILED',
                error_summary = 'Processing job dispatch was not confirmed.',
                completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
                version = version + 1
              FROM decided e
              WHERE e.status = 'FAILED'
                AND e.aggregate_type = 'PROCESSING_JOB'
                AND e.event_type = 'PROCESSING_JOB_QUEUED'
                AND p.id = e.aggregate_id AND p.status = 'PENDING'
              RETURNING p.id
            ) SELECT count(*) FROM decided
            """, Long.class, maxAttempts, safeError, delaySeconds,
            eventId, claimToken, attemptCount);
        return updated == 1;
    }

    private static Media mediaRow(ResultSet rs, int row) throws SQLException {
        return new Media(rs.getObject("id", UUID.class), rs.getObject("meeting_id", UUID.class),
            rs.getString("source_type"), rs.getString("status"), rs.getString("object_key"),
            rs.getString("original_filename"), rs.getString("content_type"), rs.getLong("expected_size_bytes"),
            (Long) rs.getObject("size_bytes"), (Long) rs.getObject("duration_ms"), rs.getString("sha256"),
            rs.getObject("uploaded_by_user_id", UUID.class), rs.getObject("created_at", OffsetDateTime.class),
            rs.getObject("available_at", OffsetDateTime.class), rs.getString("failure_code"));
    }

    private static Job jobRow(ResultSet rs, int row) throws SQLException {
        return new Job(rs.getObject("id", UUID.class), rs.getObject("meeting_id", UUID.class),
            rs.getObject("source_media_id", UUID.class), rs.getString("job_type"), rs.getString("status"),
            rs.getObject("requested_by_user_id", UUID.class), rs.getString("current_stage"),
            rs.getInt("attempt_count"), rs.getObject("queued_at", OffsetDateTime.class),
            rs.getObject("started_at", OffsetDateTime.class), rs.getObject("completed_at", OffsetDateTime.class),
            rs.getString("error_code"), rs.getString("error_summary"), rs.getString("warning_summary"),
            rs.getObject("created_at", OffsetDateTime.class), rs.getObject("updated_at", OffsetDateTime.class));
    }

    public record Media(UUID id, UUID meetingId, String sourceType, String status, String objectKey,
            String originalFilename, String contentType, long expectedSizeBytes, Long sizeBytes, Long durationMs, String sha256,
            UUID uploadedBy, OffsetDateTime createdAt, OffsetDateTime availableAt, String failureCode) { }
    public record Job(UUID id, UUID meetingId, UUID sourceMediaId, String jobType, String status,
            UUID requestedBy, String currentStage, int attemptCount, OffsetDateTime queuedAt,
            OffsetDateTime startedAt, OffsetDateTime completedAt, String errorCode, String errorSummary,
            String warningSummary, OffsetDateTime createdAt, OffsetDateTime updatedAt) { }
    public record RecentJobAdmissions(int count, long retryAfterSeconds) { }
    public record PendingCleanup(UUID id, String pendingObjectKey) { }
    public record Outbox(UUID id, String eventType, String payload, int attemptCount, UUID claimToken) { }
    public record JobQueuedEvent(UUID eventId, UUID processingJobId, UUID meetingId, UUID sourceMediaId,
            UUID requestedByUserId, String requestId, int schemaVersion, OffsetDateTime occurredAt) { }

    public static class IdempotencyConflictException extends RuntimeException { }
    public static class JobAdmissionConflictException extends RuntimeException { }
}
