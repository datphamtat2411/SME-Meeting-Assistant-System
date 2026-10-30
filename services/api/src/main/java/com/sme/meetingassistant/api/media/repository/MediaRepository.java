package com.sme.meetingassistant.api.media.repository;

import com.sme.meetingassistant.api.observability.RequestIdContext;
import com.sme.meetingassistant.api.media.dto.ProcessingStageResponse;
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
        return claimIdempotencyWithStatus(caller, operation, key, fingerprint, proposedResourceId).resourceId();
    }

    public IdempotencyClaim claimIdempotencyWithStatus(UUID caller, String operation, String key,
            String fingerprint, UUID proposedResourceId) {
        int inserted = this.jdbc.update("""
            INSERT INTO processing_job_idempotency
              (id, requester_id, operation, idempotency_key, request_fingerprint, resource_id)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (requester_id, operation, idempotency_key) DO NOTHING
            """, UUID.randomUUID(), caller, operation, key, fingerprint, proposedResourceId);
        UUID claimedId = this.jdbc.query("""
            SELECT resource_id, request_fingerprint FROM processing_job_idempotency
            WHERE requester_id = ? AND operation = ? AND idempotency_key = ?
            """, (rs, row) -> {
                if (!rs.getString("request_fingerprint").equals(fingerprint)) {
                    throw new IdempotencyConflictException();
                }
                return rs.getObject("resource_id", UUID.class);
            }, caller, operation, key).stream().findFirst().orElseThrow(IdempotencyConflictException::new);
        return new IdempotencyClaim(claimedId, inserted == 1);
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
              requested_by_user_id, reprocess_of_job_id, queued_at, created_at, updated_at)
            VALUES (?, ?, ?, 'OFFLINE_MEETING_PROCESSING', 'PENDING', ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT DO NOTHING
            """, job.id(), job.meetingId(), job.sourceMediaId(), job.requestedBy(), job.reprocessOfJobId());
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
     * A worker may see a message before the publisher confirm commits QUEUED,
     * so PENDING is an allowed starting state. The source must still be accepted.
     * The job row is the lifecycle serialization boundary.
     */
    public UUID startStage(UUID jobId, String stageCode, String providerName, String modelName) {
        List<JobStart> jobs = this.jdbc.query("""
            SELECT j.status, m.status AS media_status
            FROM processing_jobs j JOIN meeting_media m ON m.id = j.source_media_id
              AND m.meeting_id = j.meeting_id
            WHERE j.id = ? FOR UPDATE OF j
            """, (rs, row) -> new JobStart(rs.getString("status"), rs.getString("media_status")), jobId);
        if (jobs.isEmpty()) throw new IllegalArgumentException("Processing job does not exist.");
        if (!List.of("PENDING", "QUEUED", "RUNNING").contains(jobs.getFirst().status())) {
            throw new IllegalStateException("A terminal processing job cannot start another stage.");
        }
        if (!"AVAILABLE".equals(jobs.getFirst().mediaStatus())) {
            throw new IllegalStateException("Processing source media is not accepted.");
        }

        List<StageAttempt> latest = latestAttempt(jobId, stageCode);
        if (!latest.isEmpty() && "RUNNING".equals(latest.getFirst().status())) {
            // Broker redelivery must not create a new stage or bump job version.
            return latest.getFirst().id();
        }
        if (!latest.isEmpty() && !"PENDING".equals(latest.getFirst().status())) {
            throw new IllegalStateException("A completed/failed stage cannot be restarted without an explicit retry.");
        }
        if ("FINALIZING_TRANSCRIPT".equals(stageCode)
                && !hasSuccessfulTranscription(jobId)) {
            throw new IllegalStateException("Transcript finalization requires a successful transcription stage.");
        }
        if (isTranscriptDownstream(stageCode) && !hasFinalizedTranscript(jobId)) {
            throw new IllegalStateException("Downstream processing requires a persisted finalized transcript.");
        }

        this.jdbc.update("""
            UPDATE processing_jobs SET status = 'RUNNING', current_stage = ?,
              started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
              attempt_count = attempt_count + CASE WHEN status IN ('PENDING', 'QUEUED') THEN 1 ELSE 0 END,
              updated_at = CURRENT_TIMESTAMP, version = version + 1
            WHERE id = ?
            """, stageCode, jobId);

        if (!latest.isEmpty()) {
            UUID runId = latest.getFirst().id();
            this.jdbc.update("""
                UPDATE processing_stage_runs SET status = 'RUNNING', provider_name = ?, model_name = ?,
                  started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
                WHERE id = ? AND status = 'PENDING'
                """, providerName, modelName, runId);
            return runId;
        }

        UUID runId = UUID.randomUUID();
        this.jdbc.update("""
            INSERT INTO processing_stage_runs (id, processing_job_id, stage_code, attempt_number,
              status, provider_name, model_name, started_at)
            SELECT ?, ?, ?, COALESCE(MAX(attempt_number), 0) + 1, 'RUNNING', ?, ?, CURRENT_TIMESTAMP
            FROM processing_stage_runs WHERE processing_job_id = ? AND stage_code = ?
            """, runId, jobId, stageCode, providerName, modelName, jobId, stageCode);
        return runId;
    }

    public void completeStage(UUID stageRunId, String outcome, String errorCode, String metricsJson) {
        UUID jobId = stageJobId(stageRunId);
        String jobStatus = lockJobStatus(jobId);
        StageRun current = lockStage(stageRunId);
        if (outcome.equals(current.status()) && sameStageOutcome(stageRunId, outcome, errorCode, metricsJson)) {
            return;
        }
        if (!"RUNNING".equals(jobStatus) || !"RUNNING".equals(current.status())
                || !isLatestAttempt(jobId, current.stageCode(), stageRunId)) {
            throw new IllegalStateException("Stage attempt is not current or job is not running.");
        }
        if ("FINALIZING_TRANSCRIPT".equals(current.stageCode())
                && !persistedTranscript(jobId, stageRunId)) {
            throw new IllegalStateException("Cannot finalize a transcript before canonical persistence.");
        }
        int changed = this.jdbc.update("""
            UPDATE processing_stage_runs SET status = ?, error_code = ?,
              metrics = CAST(? AS jsonb), completed_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'RUNNING'
            """, outcome, errorCode, metricsJson, stageRunId);
        if (changed != 1) throw new IllegalStateException("Stage attempt changed during completion.");
    }

    public void failStage(UUID stageRunId, String errorCode, String safeSummary, boolean retryable) {
        UUID jobId = stageJobId(stageRunId);
        String jobStatus = lockJobStatus(jobId);
        StageRun current = lockStage(stageRunId);
        if ("FAILED".equals(current.status()) && "FAILED".equals(jobStatus)
                && sameStageFailure(stageRunId, errorCode, retryable)) {
            return;
        }
        if (!"RUNNING".equals(jobStatus) || !"RUNNING".equals(current.status())
                || !isLatestAttempt(jobId, current.stageCode(), stageRunId)) {
            throw new IllegalStateException("Stage attempt is not current or job is not running.");
        }
        this.jdbc.update("""
            UPDATE processing_stage_runs SET status = 'FAILED', retryable = ?, error_code = ?,
              completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'RUNNING'
            """, retryable, errorCode, stageRunId);
        int changed = this.jdbc.update("""
            UPDATE processing_jobs SET status = 'FAILED', current_stage = ?, retryable = ?,
              error_code = ?, error_summary = ?, completed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP, version = version + 1
            WHERE id = ? AND status = 'RUNNING'
            """, current.stageCode(), retryable, errorCode, safeSummary, jobId);
        if (changed != 1) throw new IllegalStateException("Processing job is no longer running.");
    }

    /**
     * Completion is derived from durable stage and transcript evidence.
     * Caller-supplied booleans cannot turn missing outputs into business success.
     */
    public void completeJob(UUID jobId) {
        String status = lockJobStatus(jobId);
        if (List.of("COMPLETED", "COMPLETED_WITH_WARNINGS").contains(status)) return;
        if (!"RUNNING".equals(status)) {
            throw new IllegalStateException("Only a running processing job can complete.");
        }
        List<StageCompletion> stages = this.jdbc.query("""
            SELECT s.id, s.stage_code, s.status
            FROM processing_stage_runs s
            WHERE s.processing_job_id = ?
              AND s.attempt_number = (SELECT MAX(x.attempt_number)
                FROM processing_stage_runs x
                WHERE x.processing_job_id = s.processing_job_id AND x.stage_code = s.stage_code)
            """, (rs, row) -> new StageCompletion(rs.getObject("id", UUID.class),
                rs.getString("stage_code"), rs.getString("status")), jobId);
        if (stages.stream().anyMatch(s -> List.of("RUNNING", "PENDING", "FAILED").contains(s.status()))) {
            throw new IllegalStateException("Processing stages are still active or have failed.");
        }
        if (!hasSuccessfulTranscription(jobId)) {
            throw new IllegalStateException("Processing cannot complete without transcription.");
        }
        StageCompletion finalized = stages.stream()
            .filter(s -> "FINALIZING_TRANSCRIPT".equals(s.stageCode())
                && isSuccessful(s.status())).findFirst()
            .orElseThrow(() -> new IllegalStateException("Transcript finalization has not succeeded."));
        List<TranscriptEvidence> results = transcriptEvidence(jobId, finalized.id());
        if (results.size() != 1 || !List.of("READY", "READY_WITH_WARNINGS").contains(results.getFirst().status())) {
            throw new IllegalStateException("A valid finalized transcript is required.");
        }
        TranscriptEvidence transcript = results.getFirst();
        if (transcript.suspicious() && "READY".equals(transcript.status())) {
            throw new IllegalStateException("Unresolved transcript quality cannot be marked READY.");
        }
        boolean withWarnings = "READY_WITH_WARNINGS".equals(transcript.status())
            || stages.stream().anyMatch(s -> "SUCCEEDED_WITH_WARNING".equals(s.status()));
        String outcome = withWarnings ? "COMPLETED_WITH_WARNINGS" : "COMPLETED";
        String summary = withWarnings ? "Processing completed with transcript or stage quality warnings." : null;
        int changed = this.jdbc.update("""
            UPDATE processing_jobs SET status = ?, warning_summary = ?, retryable = FALSE,
              error_code = NULL, error_summary = NULL, completed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP, version = version + 1
            WHERE id = ? AND status = 'RUNNING'
            """, outcome, summary, jobId);
        if (changed != 1) throw new IllegalStateException("Processing job is no longer running.");
    }

    private List<StageAttempt> latestAttempt(UUID jobId, String stageCode) {
        return this.jdbc.query("""
            SELECT id, attempt_number, status FROM processing_stage_runs
            WHERE processing_job_id = ? AND stage_code = ?
            ORDER BY attempt_number DESC LIMIT 1
            """, (rs, row) -> new StageAttempt(rs.getObject("id", UUID.class),
                rs.getInt("attempt_number"), rs.getString("status")), jobId, stageCode);
    }

    private boolean isLatestAttempt(UUID jobId, String stageCode, UUID stageRunId) {
        return latestAttempt(jobId, stageCode).stream().anyMatch(a -> a.id().equals(stageRunId));
    }

    private static boolean isSuccessful(String status) {
        return "SUCCEEDED".equals(status) || "SUCCEEDED_WITH_WARNING".equals(status);
    }

    private boolean hasSuccessfulTranscription(UUID jobId) {
        return latestAttempt(jobId, "TRANSCRIPTION").stream().anyMatch(s -> isSuccessful(s.status()))
            || latestAttempt(jobId, "TRANSCRIBING").stream().anyMatch(s -> isSuccessful(s.status()));
    }

    private boolean hasFinalizedTranscript(UUID jobId) {
        return latestAttempt(jobId, "FINALIZING_TRANSCRIPT").stream()
            .anyMatch(s -> isSuccessful(s.status()) && persistedTranscript(jobId, s.id()));
    }

    private static boolean isTranscriptDownstream(String stageCode) {
        return List.of("GENERATING_SUMMARY", "EXTRACTING_DECISIONS",
            "EXTRACTING_ACTION_ITEMS", "INDEXING").contains(stageCode);
    }

    private boolean persistedTranscript(UUID jobId, UUID stageRunId) {
        return !transcriptEvidence(jobId, stageRunId).isEmpty();
    }

    private List<TranscriptEvidence> transcriptEvidence(UUID jobId, UUID stageRunId) {
        return this.jdbc.query("""
            SELECT t.status,
              EXISTS (SELECT 1 FROM transcript_segments s WHERE s.transcript_id = t.id
                AND s.quality_status <> 'ACCEPTED')
              OR EXISTS (SELECT 1 FROM transcript_coverage_regions c
                WHERE c.transcript_id = t.id AND c.coverage_status <> 'COVERED')
                AS suspicious
            FROM transcripts t
            JOIN processing_jobs j ON j.id = t.processing_job_id
              AND j.meeting_id = t.meeting_id AND j.source_media_id = t.source_media_id
            JOIN processing_stage_runs sr ON sr.id = t.source_stage_run_id
              AND sr.processing_job_id = j.id AND sr.stage_code = 'FINALIZING_TRANSCRIPT'
            WHERE j.id = ? AND sr.id = ?
              AND t.status IN ('READY', 'READY_WITH_WARNINGS')
              AND EXISTS (SELECT 1 FROM transcript_segments s WHERE s.transcript_id = t.id)
            """, (rs, row) -> new TranscriptEvidence(rs.getString("status"),
                rs.getBoolean("suspicious")), jobId, stageRunId);
    }

    private UUID stageJobId(UUID stageRunId) {
        return this.jdbc.query("""
            SELECT processing_job_id FROM processing_stage_runs WHERE id = ?
            """, (rs, row) -> rs.getObject("processing_job_id", UUID.class), stageRunId)
            .stream().findFirst().orElseThrow(() -> new IllegalArgumentException("Stage attempt does not exist."));
    }

    private String lockJobStatus(UUID jobId) {
        return this.jdbc.query("""
            SELECT status FROM processing_jobs WHERE id = ? FOR UPDATE
            """, (rs, row) -> rs.getString("status"), jobId).stream().findFirst()
            .orElseThrow(() -> new IllegalArgumentException("Processing job does not exist."));
    }

    private StageRun lockStage(UUID stageRunId) {
        return this.jdbc.query("""
            SELECT stage_code, status FROM processing_stage_runs WHERE id = ? FOR UPDATE
            """, (rs, row) -> new StageRun(rs.getString("stage_code"), rs.getString("status")), stageRunId)
            .stream().findFirst().orElseThrow(() -> new IllegalArgumentException("Stage attempt does not exist."));
    }

    private boolean sameStageOutcome(UUID stageRunId, String outcome, String errorCode, String metricsJson) {
        return Boolean.TRUE.equals(this.jdbc.queryForObject("""
            SELECT EXISTS (SELECT 1 FROM processing_stage_runs
              WHERE id = ? AND status = ? AND error_code IS NOT DISTINCT FROM ?
                AND metrics IS NOT DISTINCT FROM CAST(? AS jsonb))
            """, Boolean.class, stageRunId, outcome, errorCode, metricsJson));
    }

    private boolean sameStageFailure(UUID stageRunId, String errorCode, boolean retryable) {
        return Boolean.TRUE.equals(this.jdbc.queryForObject("""
            SELECT EXISTS (SELECT 1 FROM processing_stage_runs
              WHERE id = ? AND status = 'FAILED' AND error_code = ? AND retryable = ?)
            """, Boolean.class, stageRunId, errorCode, retryable));
    }

    public void recordArtifact(UUID jobId, UUID stageRunId, String artifactType, String objectKey,
            String sha256, Long sizeBytes, String retentionClass) {
        int inserted = this.jdbc.update("""
            INSERT INTO processing_artifacts (id, processing_job_id, stage_run_id, artifact_type,
              object_key, sha256, size_bytes, retention_class)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM processing_stage_runs
              WHERE id = ? AND processing_job_id = ?)
            ON CONFLICT (object_key) DO NOTHING
            """, UUID.randomUUID(), jobId, stageRunId, artifactType, objectKey,
            sha256, sizeBytes, retentionClass, stageRunId, jobId);
        if (inserted == 1) return;
        boolean replay = Boolean.TRUE.equals(this.jdbc.queryForObject("""
            SELECT EXISTS (SELECT 1 FROM processing_artifacts WHERE object_key = ?
              AND processing_job_id = ? AND stage_run_id = ? AND artifact_type = ?
              AND sha256 IS NOT DISTINCT FROM ? AND size_bytes IS NOT DISTINCT FROM ?
              AND retention_class IS NOT DISTINCT FROM ?)
            """, Boolean.class, objectKey, jobId, stageRunId, artifactType,
            sha256, sizeBytes, retentionClass));
        if (!replay) throw new IllegalStateException("Artifact reference is invalid or conflicts with existing metadata.");
    }

    public List<ProcessingStageResponse> listStageRuns(UUID jobId) {
        return this.jdbc.query("""
            SELECT id, stage_code, attempt_number, status, provider_name, model_name,
                   started_at, completed_at, error_code
            FROM processing_stage_runs WHERE processing_job_id = ?
            ORDER BY stage_code, attempt_number
            """, (rs, row) -> new ProcessingStageResponse(rs.getObject("id", UUID.class),
                rs.getString("stage_code"), rs.getInt("attempt_number"), rs.getString("status"),
                rs.getString("provider_name"), rs.getString("model_name"),
                rs.getObject("started_at", OffsetDateTime.class),
                rs.getObject("completed_at", OffsetDateTime.class), rs.getString("error_code")), jobId);
    }

    public boolean hasRetryableFailedStage(UUID jobId, String stageCode) {
        return Boolean.TRUE.equals(this.jdbc.queryForObject("""
            SELECT EXISTS (SELECT 1 FROM processing_stage_runs
              WHERE processing_job_id = ? AND stage_code = ? AND status = 'FAILED' AND retryable = TRUE
                AND attempt_number = (SELECT MAX(attempt_number) FROM processing_stage_runs
                  WHERE processing_job_id = ? AND stage_code = ?))
            """, Boolean.class, jobId, stageCode, jobId, stageCode));
    }

    public boolean retryJobAndOutbox(Job job, UUID eventId, String stageCode, int maxRetries) {
        int updated = this.jdbc.update("""
            UPDATE processing_jobs SET status = 'PENDING', current_stage = COALESCE(?, current_stage),
              queued_at = NULL, completed_at = NULL, error_code = NULL, error_summary = NULL,
              retryable = FALSE, retry_count = retry_count + 1,
              updated_at = CURRENT_TIMESTAMP, version = version + 1
            WHERE id = ? AND status = 'FAILED' AND retry_count < ? AND (retryable = TRUE OR ?)
            """, stageCode, job.id(), maxRetries, stageCode != null);
        if (updated != 1) return false;
        if (stageCode != null) {
            int inserted = this.jdbc.update("""
                INSERT INTO processing_stage_runs (id, processing_job_id, stage_code, attempt_number,
                  status, retryable, created_at)
                SELECT ?, ?, ?, COALESCE(MAX(attempt_number), 0) + 1, 'PENDING', FALSE, CURRENT_TIMESTAMP
                FROM processing_stage_runs WHERE processing_job_id = ? AND stage_code = ?
                """, UUID.randomUUID(), job.id(), stageCode, job.id(), stageCode);
            if (inserted != 1) throw new IllegalStateException("Could not create the retry stage attempt.");
        }
        String payload;
        try {
            payload = this.mapper.writeValueAsString(new JobRetryEvent(eventId, job.id(), job.meetingId(),
                job.sourceMediaId(), job.requestedBy(), stageCode, job.retryCount() + 1,
                RequestIdContext.currentRequestId(), 2, OffsetDateTime.now()));
        } catch (JacksonException exception) {
            throw new IllegalStateException("Could not serialize processing retry event", exception);
        }
        this.jdbc.update("""
            INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, occurred_at)
            VALUES (?, 'PROCESSING_JOB', ?, 'PROCESSING_JOB_RETRY_REQUESTED', CAST(? AS jsonb), CURRENT_TIMESTAMP)
            """, eventId, job.id(), payload);
        return true;
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
              WHERE status = 'PENDING' AND aggregate_type = 'PROCESSING_JOB'
                AND event_type IN ('PROCESSING_JOB_QUEUED', 'PROCESSING_JOB_RETRY_REQUESTED')
                AND attempt_count >= ?
                AND (claim_expires_at IS NULL OR claim_expires_at <= CURRENT_TIMESTAMP)
              RETURNING aggregate_id, aggregate_type, event_type, payload
            ), failed_jobs AS (
              UPDATE processing_jobs p SET status = 'FAILED',
                error_code = 'JOB_DISPATCH_FAILED',
                error_summary = 'Processing job dispatch was not confirmed.',
                completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
                version = version + 1
              FROM exhausted e
              WHERE e.aggregate_type = 'PROCESSING_JOB'
                AND (
                  (e.event_type = 'PROCESSING_JOB_QUEUED' AND p.retry_count = 0)
                  OR (e.event_type = 'PROCESSING_JOB_RETRY_REQUESTED'
                    AND e.payload->>'attemptNumber' = p.retry_count::text)
                )
                AND p.id = e.aggregate_id AND p.status = 'PENDING'
              RETURNING p.id
            ) SELECT count(*) FROM exhausted
            """, Long.class, maxAttempts);
        return this.jdbc.query("""
            WITH candidates AS (
              SELECT id FROM outbox_events
              WHERE status = 'PENDING' AND aggregate_type = 'PROCESSING_JOB'
                AND event_type IN ('PROCESSING_JOB_QUEUED', 'PROCESSING_JOB_RETRY_REQUESTED')
                AND attempt_count < ?
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
              RETURNING aggregate_id, aggregate_type, event_type, payload
            ), queued_jobs AS (
              UPDATE processing_jobs p SET status = 'QUEUED',
                queued_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
                version = version + 1
              FROM published e
              WHERE e.aggregate_type = 'PROCESSING_JOB'
                AND (
                  (e.event_type = 'PROCESSING_JOB_QUEUED' AND p.retry_count = 0)
                  OR (e.event_type = 'PROCESSING_JOB_RETRY_REQUESTED'
                    AND e.payload->>'attemptNumber' = p.retry_count::text)
                )
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
              RETURNING aggregate_id, aggregate_type, event_type, status, payload
            ), failed_jobs AS (
              UPDATE processing_jobs p SET status = 'FAILED',
                error_code = 'JOB_DISPATCH_FAILED',
                error_summary = 'Processing job dispatch was not confirmed.',
                completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
                version = version + 1
              FROM decided e
              WHERE e.status = 'FAILED'
                AND e.aggregate_type = 'PROCESSING_JOB'
                AND (
                  (e.event_type = 'PROCESSING_JOB_QUEUED' AND p.retry_count = 0)
                  OR (e.event_type = 'PROCESSING_JOB_RETRY_REQUESTED'
                    AND e.payload->>'attemptNumber' = p.retry_count::text)
                )
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
            rs.getObject("created_at", OffsetDateTime.class), rs.getObject("updated_at", OffsetDateTime.class),
            rs.getObject("reprocess_of_job_id", UUID.class), rs.getBoolean("retryable"),
            rs.getInt("retry_count"));
    }

    public record Media(UUID id, UUID meetingId, String sourceType, String status, String objectKey,
            String originalFilename, String contentType, long expectedSizeBytes, Long sizeBytes, Long durationMs, String sha256,
            UUID uploadedBy, OffsetDateTime createdAt, OffsetDateTime availableAt, String failureCode) { }
    public record Job(UUID id, UUID meetingId, UUID sourceMediaId, String jobType, String status,
            UUID requestedBy, String currentStage, int attemptCount, OffsetDateTime queuedAt,
            OffsetDateTime startedAt, OffsetDateTime completedAt, String errorCode, String errorSummary,
            String warningSummary, OffsetDateTime createdAt, OffsetDateTime updatedAt,
            UUID reprocessOfJobId, boolean retryable, int retryCount) {
        public Job(UUID id, UUID meetingId, UUID sourceMediaId, String jobType, String status,
                UUID requestedBy, String currentStage, int attemptCount, OffsetDateTime queuedAt,
                OffsetDateTime startedAt, OffsetDateTime completedAt, String errorCode, String errorSummary,
                String warningSummary, OffsetDateTime createdAt, OffsetDateTime updatedAt,
                UUID reprocessOfJobId, boolean retryable) {
            this(id, meetingId, sourceMediaId, jobType, status, requestedBy, currentStage, attemptCount,
                queuedAt, startedAt, completedAt, errorCode, errorSummary, warningSummary, createdAt,
                updatedAt, reprocessOfJobId, retryable, 0);
        }
        public Job(UUID id, UUID meetingId, UUID sourceMediaId, String jobType, String status,
                UUID requestedBy, String currentStage, int attemptCount, OffsetDateTime queuedAt,
                OffsetDateTime startedAt, OffsetDateTime completedAt, String errorCode, String errorSummary,
                String warningSummary, OffsetDateTime createdAt, OffsetDateTime updatedAt) {
            this(id, meetingId, sourceMediaId, jobType, status, requestedBy, currentStage, attemptCount,
                queuedAt, startedAt, completedAt, errorCode, errorSummary, warningSummary, createdAt,
                updatedAt, null, false, 0);
        }
    }
    public record RecentJobAdmissions(int count, long retryAfterSeconds) { }
    public record IdempotencyClaim(UUID resourceId, boolean claimed) { }
    private record JobStart(String status, String mediaStatus) { }
    private record StageRun(String stageCode, String status) { }
    private record StageCompletion(UUID id, String stageCode, String status) { }
    private record TranscriptEvidence(String status, boolean suspicious) { }
    private record StageAttempt(UUID id, int attemptNumber, String status) { }
    private record StageJob(UUID jobId, String stageCode, String status) { }
    public record PendingCleanup(UUID id, String pendingObjectKey) { }
    public record Outbox(UUID id, String eventType, String payload, int attemptCount, UUID claimToken) { }
    public record JobQueuedEvent(UUID eventId, UUID processingJobId, UUID meetingId, UUID sourceMediaId,
            UUID requestedByUserId, String requestId, int schemaVersion, OffsetDateTime occurredAt) { }
    public record JobRetryEvent(UUID eventId, UUID processingJobId, UUID meetingId, UUID sourceMediaId,
            UUID requestedByUserId, String retryFromStage, int attemptNumber, String requestId,
            int schemaVersion, OffsetDateTime occurredAt) { }

    public static class IdempotencyConflictException extends RuntimeException { }
    public static class JobAdmissionConflictException extends RuntimeException { }
}
