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

    public void insertJobAndOutbox(Job job, UUID eventId) {
        this.jdbc.update("""
            INSERT INTO processing_jobs (id, meeting_id, source_media_id, job_type, status,
              requested_by_user_id, queued_at, created_at, updated_at)
            VALUES (?, ?, ?, 'OFFLINE_MEETING_PROCESSING', 'QUEUED', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """, job.id(), job.meetingId(), job.sourceMediaId(), job.requestedBy());
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

    public List<Outbox> pendingOutbox(int limit) {
        return this.jdbc.query("""
            SELECT id, event_type, payload::text AS payload, attempt_count
            FROM outbox_events WHERE status = 'PENDING' AND next_attempt_at <= CURRENT_TIMESTAMP
            ORDER BY occurred_at, id LIMIT ?
            """, (rs, row) -> new Outbox(rs.getObject("id", UUID.class), rs.getString("event_type"),
                rs.getString("payload"), rs.getInt("attempt_count")), limit);
    }

    public void markPublished(UUID eventId) {
        this.jdbc.update("UPDATE outbox_events SET status = 'PUBLISHED', published_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?",
            eventId);
    }

    public void markPublishFailed(UUID eventId, int attempts, int maxAttempts, String error) {
        this.jdbc.update("""
            UPDATE outbox_events SET attempt_count = ?, status = ?, last_error = ?,
              next_attempt_at = CURRENT_TIMESTAMP + (? * INTERVAL '1 second')
            WHERE id = ?
            """, attempts + 1, attempts + 1 >= maxAttempts ? "FAILED" : "PENDING",
            error.substring(0, Math.min(error.length(), 1000)), Math.min(300, 1L << Math.min(attempts, 8)), eventId);
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
    public record PendingCleanup(UUID id, String pendingObjectKey) { }
    public record Outbox(UUID id, String eventType, String payload, int attemptCount) { }
    public record JobQueuedEvent(UUID eventId, UUID processingJobId, UUID meetingId, UUID sourceMediaId,
            UUID requestedByUserId, String requestId, int schemaVersion, OffsetDateTime occurredAt) { }

    public static class IdempotencyConflictException extends RuntimeException { }
}
