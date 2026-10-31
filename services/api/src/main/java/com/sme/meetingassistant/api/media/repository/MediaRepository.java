package com.sme.meetingassistant.api.media.repository;

import com.sme.meetingassistant.api.observability.RequestIdContext;
import com.sme.meetingassistant.api.media.dto.ProcessingStageResponse;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.media.service.ProcessingTranscriptEvidence.Evidence;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
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

    /** Read-only replay fast-path; transactional claim remains authoritative. */
    public Optional<UUID> findDerivedSummaryIdempotency(UUID actor,String operation,String key) {
        return jdbc.query("""
            SELECT resource_id FROM processing_job_idempotency
            WHERE requester_id=? AND operation=? AND idempotency_key=?
            """,(rs,n)->rs.getObject("resource_id",UUID.class),actor,operation,key)
            .stream().findFirst();
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

    public void insertJobAndOutbox(Job job, UUID eventId, List<String> requiredDownstreamStages) {
        int inserted = this.jdbc.update("""
            INSERT INTO processing_jobs (id, meeting_id, source_media_id, job_type, status,
              requested_by_user_id, reprocess_of_job_id, queued_at, created_at, updated_at)
            VALUES (?, ?, ?, 'OFFLINE_MEETING_PROCESSING', 'PENDING', ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT DO NOTHING
            """, job.id(), job.meetingId(), job.sourceMediaId(), job.requestedBy(), job.reprocessOfJobId());
        if (inserted != 1) throw new JobAdmissionConflictException();
        // Each newly admitted job must complete whole-meeting contextual correction.
        // Historical pre-hardening jobs have no planned correction attempt.
        this.jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'CONTEXTUAL_CORRECTION',1,'PENDING')
            """, UUID.randomUUID(), job.id());
        // Snapshot the pipeline plan at admission; later configuration changes
        // must not silently alter the obligations of a running job.
        for (String stage : requiredDownstreamStages) {
            this.jdbc.update("""
                INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
                VALUES (?,?,?,1,'PENDING')
                """, UUID.randomUUID(), job.id(), stage);
        }
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

    /**
     * MI-08 derived-only admission: exactly one summary stage, no transcription
     * or correction plan. Uses the same outbox envelope/relay as ordinary jobs.
     * The caller must persist the immutable source snapshot in this transaction
     * before commit makes the event visible to the publisher.
     */
    public void insertDerivedSummaryJobAndOutbox(UUID jobId, UUID meetingId, UUID mediaId,
            UUID actorId, UUID parentJobId, UUID eventId) {
        int count = jdbc.update("""
            INSERT INTO processing_jobs(
                id,meeting_id,source_media_id,job_type,status,requested_by_user_id,
                reprocess_of_job_id,queued_at,created_at,updated_at)
            VALUES (?,?,?,'DERIVED_STAGE_PROCESSING','PENDING',?,?,NULL,
                CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
            ON CONFLICT DO NOTHING
            """,jobId,meetingId,mediaId,actorId,parentJobId);
        if(count!=1) throw new JobAdmissionConflictException();
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'GENERATING_SUMMARY',1,'PENDING')
            """,UUID.randomUUID(),jobId);
        String payload;
        try {
            payload=this.mapper.writeValueAsString(new JobQueuedEvent(
                eventId,jobId,meetingId,mediaId,actorId,
                RequestIdContext.currentRequestId(),1,OffsetDateTime.now()));
        } catch(JacksonException failure) {
            throw new IllegalStateException("Cannot encode derived processing notification.",failure);
        }
        jdbc.update("""
            INSERT INTO outbox_events(
                id,aggregate_type,aggregate_id,event_type,payload,occurred_at)
            VALUES (?,'PROCESSING_JOB',?,'PROCESSING_JOB_QUEUED',CAST(? AS jsonb),CURRENT_TIMESTAMP)
            """,eventId,jobId,payload);
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
    /**
     * Only one worker owns a stage at a time. A broker duplicate cannot obtain
     * the token of an existing claim. Expired claims must be reconciled before retry.
     */
    public StageClaim startStage(UUID jobId, String stageCode, String providerName,
            String modelName, int leaseSeconds) {
        List<JobStart> jobs = this.jdbc.query("""
            SELECT j.status, m.status AS media_status
            FROM processing_jobs j JOIN meeting_media m ON m.id = j.source_media_id
              AND m.meeting_id = j.meeting_id
            WHERE j.id = ? FOR UPDATE OF j
            """, (rs, row) -> new JobStart(rs.getString("status"), rs.getString("media_status")), jobId);
        if (jobs.isEmpty()) throw new IllegalArgumentException("Processing job does not exist.");
        if (!List.of("PENDING", "QUEUED", "RUNNING").contains(jobs.getFirst().status())) {
            throw new ProcessingLifecycleConflictException("A terminal processing job cannot start another stage.");
        }
        if (!"AVAILABLE".equals(jobs.getFirst().mediaStatus())) {
            throw new ProcessingLifecycleConflictException("Processing source media is not accepted.");
        }
        if (Boolean.TRUE.equals(this.jdbc.queryForObject("""
            SELECT EXISTS (SELECT 1 FROM processing_stage_runs
              WHERE processing_job_id = ? AND status = 'RUNNING')
            """, Boolean.class, jobId))) {
            throw new ProcessingLifecycleConflictException("Another worker already owns a running stage.");
        }

        List<StageAttempt> latest = latestAttempt(jobId, stageCode);
        if (!latest.isEmpty() && !"PENDING".equals(latest.getFirst().status())) {
            throw new ProcessingLifecycleConflictException("A completed/failed stage cannot be restarted without an explicit retry.");
        }
        if ("CONTEXTUAL_CORRECTION".equals(stageCode) && !hasSuccessfulTranscription(jobId)) {
            throw new ProcessingLifecycleConflictException("Contextual correction requires completed transcription.");
        }
        if ("FINALIZING_TRANSCRIPT".equals(stageCode) && !hasSuccessfulTranscription(jobId)) {
            throw new ProcessingLifecycleConflictException("Transcript finalization requires successful transcription.");
        }
        if ("FINALIZING_TRANSCRIPT".equals(stageCode) && hasCorrectionPlan(jobId)
                && !hasSuccessfulContextualCorrection(jobId)) {
            throw new ProcessingLifecycleConflictException("Whole-meeting contextual correction must succeed first.");
        }
        UUID token = UUID.randomUUID();
        this.jdbc.update("""
            UPDATE processing_jobs SET status = 'RUNNING', current_stage = ?,
              started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
              attempt_count = attempt_count + CASE WHEN status IN ('PENDING', 'QUEUED') THEN 1 ELSE 0 END,
              updated_at = CURRENT_TIMESTAMP, version = version + 1
            WHERE id = ?
            """, stageCode, jobId);
        if (!latest.isEmpty()) {
            UUID runId = latest.getFirst().id();
            int changed = this.jdbc.update("""
                UPDATE processing_stage_runs SET status = 'RUNNING', provider_name = ?, model_name = ?,
                  started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
                  claim_token = ?, lease_expires_at = clock_timestamp() + (? * INTERVAL '1 second')
                WHERE id = ? AND status = 'PENDING'
                """, providerName, modelName, token, leaseSeconds, runId);
            if (changed != 1) throw new ProcessingLifecycleConflictException("Stage attempt was already claimed.");
            return new StageClaim(runId, token);
        }

        UUID runId = UUID.randomUUID();
        this.jdbc.update("""
            INSERT INTO processing_stage_runs (id, processing_job_id, stage_code, attempt_number,
              status, provider_name, model_name, started_at, claim_token, lease_expires_at)
            SELECT ?, ?, ?, COALESCE(MAX(attempt_number), 0) + 1,
              'RUNNING', ?, ?, CURRENT_TIMESTAMP, ?, clock_timestamp() + (? * INTERVAL '1 second')
            FROM processing_stage_runs WHERE processing_job_id = ? AND stage_code = ?
            """, runId, jobId, stageCode, providerName, modelName,
            token, leaseSeconds, jobId, stageCode);
        return new StageClaim(runId, token);
    }

    public void renewStageLease(StageClaim claim, int leaseSeconds) {
        UUID jobId = stageJobId(claim.stageRunId());
        String status = lockJobStatus(jobId);
        if (!"RUNNING".equals(status) || !this.isLatestClaim(jobId, claim)) {
            throw new ProcessingLifecycleConflictException("Only the current worker may renew a stage lease.");
        }
        int changed = this.jdbc.update("""
            UPDATE processing_stage_runs
            SET lease_expires_at = clock_timestamp() + (? * INTERVAL '1 second')
            WHERE id = ? AND claim_token = ? AND status = 'RUNNING'
              AND lease_expires_at > clock_timestamp()
            """, leaseSeconds, claim.stageRunId(), claim.claimToken());
        if (changed != 1) throw new ProcessingLifecycleConflictException("Stage claim has expired or was superseded.");
    }

    private boolean isLatestClaim(UUID jobId, StageClaim claim) {
        return Boolean.TRUE.equals(this.jdbc.queryForObject("""
            SELECT EXISTS (
              SELECT 1 FROM processing_stage_runs sr
              WHERE sr.id = ? AND sr.processing_job_id = ? AND sr.claim_token = ?
                AND sr.attempt_number = (
                  SELECT MAX(x.attempt_number) FROM processing_stage_runs x
                  WHERE x.processing_job_id = sr.processing_job_id AND x.stage_code = sr.stage_code)
            )
            """, Boolean.class, claim.stageRunId(), jobId, claim.claimToken()));
    }

    private boolean liveClaim(StageClaim claim) {
        return Boolean.TRUE.equals(this.jdbc.queryForObject("""
            SELECT EXISTS (SELECT 1 FROM processing_stage_runs
              WHERE id = ? AND claim_token = ? AND lease_expires_at > clock_timestamp())
            """, Boolean.class, claim.stageRunId(), claim.claimToken()));
    }


    /**
     * Application-level finalization admission. Called after the meeting row
     * is locked, before transcript publication. The processing job lock and
     * claim-token/lease check fence stale or competing workers.
     */
    public boolean requireFinalizationClaim(UUID jobId, UUID meetingId, UUID mediaId,
            StageClaim claim) {
        if (jobId == null || meetingId == null || mediaId == null || claim == null
                || claim.stageRunId() == null || claim.claimToken() == null) {
            throw new IllegalArgumentException("Finalization identity and stage claim are required.");
        }
        List<FinalizationState> matches = this.jdbc.query("""
            SELECT j.status AS job_status, s.status AS stage_status, s.stage_code,
                   m.status AS media_status
            FROM processing_jobs j
            JOIN meeting_media m ON m.id = j.source_media_id
               AND m.meeting_id = j.meeting_id
            JOIN processing_stage_runs s ON s.processing_job_id = j.id
            WHERE j.id=? AND j.meeting_id=? AND j.source_media_id=?
              AND s.id=? AND s.claim_token=?
            FOR UPDATE OF j
            """, (rs, row) -> new FinalizationState(rs.getString("job_status"),
                rs.getString("stage_status"), rs.getString("stage_code"),
                rs.getString("media_status")), jobId, meetingId, mediaId,
                claim.stageRunId(), claim.claimToken());
        if (matches.size() != 1 || !"FINALIZING_TRANSCRIPT".equals(matches.getFirst().stageCode())
                || !isLatestClaim(jobId, claim)
                || !"AVAILABLE".equals(matches.getFirst().mediaStatus())) {
            throw new ProcessingLifecycleConflictException(
                "Finalization claim does not match the current accepted job and media.");
        }
        FinalizationState state = matches.getFirst();
        if ("RUNNING".equals(state.jobStatus()) && isSuccessful(state.stageStatus())) {
            // Duplicate transcript result while downstream stages are pending.
            return true;
        }
        if ("RUNNING".equals(state.jobStatus()) && "RUNNING".equals(state.stageStatus())) {
            if (!liveClaim(claim)) {
                throw new ProcessingLifecycleConflictException("Finalization worker lease has expired.");
            }
            return false;
        }
        if (List.of("COMPLETED", "COMPLETED_WITH_WARNINGS").contains(state.jobStatus())
                && isSuccessful(state.stageStatus())) {
            return true;
        }
        throw new ProcessingLifecycleConflictException(
            "Finalization worker no longer owns a valid running or completed stage.");
    }

    public void completeStage(StageClaim claim, String outcome, String errorCode, String metricsJson) {
        UUID stageRunId = claim.stageRunId();
        UUID jobId = stageJobId(stageRunId);
        String jobStatus = lockJobStatus(jobId);
        StageRun current = lockStage(stageRunId);
        if (isLatestClaim(jobId, claim) && outcome.equals(current.status())
                && sameStageOutcome(stageRunId, outcome, errorCode, metricsJson)) {
            return;
        }
        if (!"RUNNING".equals(jobStatus) || !"RUNNING".equals(current.status())
                || !isLatestClaim(jobId, claim) || !liveClaim(claim)) {
            throw new ProcessingLifecycleConflictException("Stage attempt is not current or job is not running.");
        }
        if ("CONTEXTUAL_CORRECTION".equals(current.stageCode())) {
            boolean validProof = metricsJson != null && Boolean.TRUE.equals(this.jdbc.queryForObject("""
                SELECT CAST(? AS jsonb)->>'contextScope' = 'WHOLE_MEETING'
                  AND CAST(? AS jsonb)->>'outputSha256' ~ '^[0-9a-f]{64}$'
                  AND length(btrim(COALESCE(CAST(? AS jsonb)->>'promptVersion',''))) BETWEEN 1 AND 80
                """, Boolean.class, metricsJson, metricsJson, metricsJson));
            if (!validProof) {
                throw new ProcessingLifecycleConflictException(
                    "Contextual correction requires whole-meeting evidence, output digest and prompt version.");
            }
        }
        int changed = this.jdbc.update("""
            UPDATE processing_stage_runs SET status = ?, error_code = ?,
              metrics = CAST(? AS jsonb), completed_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'RUNNING'
            """, outcome, errorCode, metricsJson, stageRunId);
        if (changed != 1) throw new ProcessingLifecycleConflictException("Stage attempt changed during completion.");
    }

    public void failStage(StageClaim claim, String errorCode, String safeSummary, boolean retryable) {
        UUID stageRunId = claim.stageRunId();
        UUID jobId = stageJobId(stageRunId);
        String jobStatus = lockJobStatus(jobId);
        StageRun current = lockStage(stageRunId);
        if ("FAILED".equals(current.status()) && "FAILED".equals(jobStatus)
                && isLatestClaim(jobId, claim) && sameStageFailure(stageRunId, errorCode, retryable)) {
            return;
        }
        if (!"RUNNING".equals(jobStatus) || !"RUNNING".equals(current.status())
                || !isLatestClaim(jobId, claim) || !liveClaim(claim)) {
            throw new ProcessingLifecycleConflictException("Stage attempt is not current or job is not running.");
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
        if (changed != 1) throw new ProcessingLifecycleConflictException("Processing job is no longer running.");
    }

    /**
     * Completion is derived from durable stage and transcript evidence.
     * Caller-supplied booleans cannot turn missing outputs into business success.
     */
    public boolean hasPendingPipelineStages(UUID jobId) {
        return Boolean.TRUE.equals(this.jdbc.queryForObject("""
            SELECT EXISTS (SELECT 1 FROM processing_stage_runs
              WHERE processing_job_id=? AND status='PENDING'
                AND stage_code IN ('GENERATING_SUMMARY', 'EXTRACTING_DECISIONS',
                                   'EXTRACTING_ACTION_ITEMS', 'INDEXING'))
            """, Boolean.class, jobId));
    }

    public boolean isDerivedSummaryJob(UUID jobId) {
        return Boolean.TRUE.equals(jdbc.queryForObject("""
            SELECT EXISTS(SELECT 1 FROM processing_jobs
                WHERE id=? AND job_type='DERIVED_STAGE_PROCESSING')
            """, Boolean.class, jobId));
    }

    /** Derived-only completion has its own policy: never demand same-job ASR. */
    public void completeDerivedSummaryJob(UUID jobId) {
        String current=lockJobStatus(jobId);
        if ("COMPLETED".equals(current) || "COMPLETED_WITH_WARNINGS".equals(current)) return;
        if (!"RUNNING".equals(current) || !isDerivedSummaryJob(jobId))
            throw new ProcessingLifecycleConflictException("Derived Summary job is not running.");
        List<StageCompletion> stages=jdbc.query("""
            SELECT stage_code,status FROM processing_stage_runs s
            WHERE processing_job_id=?
              AND attempt_number=(
                SELECT MAX(x.attempt_number) FROM processing_stage_runs x
                WHERE x.processing_job_id=s.processing_job_id AND x.stage_code=s.stage_code)
            """,(rs,n)->new StageCompletion(null,rs.getString("stage_code"),
                rs.getString("status")),jobId);
        if (stages.size()!=1 || !"GENERATING_SUMMARY".equals(stages.getFirst().stageCode())
                || !isSuccessful(stages.getFirst().status())) {
            throw new ProcessingLifecycleConflictException(
                "Derived job must complete its sole Summary stage.");
        }
        boolean warnings="SUCCEEDED_WITH_WARNING".equals(stages.getFirst().status());
        int changed=jdbc.update("""
            UPDATE processing_jobs SET
              status=?,warning_summary=?,retryable=FALSE,error_code=NULL,
              error_summary=NULL,completed_at=CURRENT_TIMESTAMP,
              updated_at=CURRENT_TIMESTAMP,version=version+1
            WHERE id=? AND status='RUNNING' AND job_type='DERIVED_STAGE_PROCESSING'
            """,warnings?"COMPLETED_WITH_WARNINGS":"COMPLETED",
            warnings?"Summary generated with source quality warnings.":null,jobId);
        if(changed!=1) throw new ProcessingLifecycleConflictException(
            "Derived job changed during completion.");
    }

    public void completeJob(UUID jobId, Evidence evidence) {
        String status = lockJobStatus(jobId);
        if (List.of("COMPLETED", "COMPLETED_WITH_WARNINGS").contains(status)) return;
        if (!"RUNNING".equals(status)) {
            throw new ProcessingLifecycleConflictException("Only a running processing job can complete.");
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
            throw new ProcessingLifecycleConflictException("Processing stages are still active or have failed.");
        }
        if (!hasSuccessfulTranscription(jobId)) {
            throw new ProcessingLifecycleConflictException("Processing cannot complete without transcription.");
        }
        if (hasCorrectionPlan(jobId) && !hasSuccessfulContextualCorrection(jobId)) {
            throw new ProcessingLifecycleConflictException("Contextual correction has not completed successfully.");
        }
        StageCompletion finalized = stages.stream()
            .filter(s -> "FINALIZING_TRANSCRIPT".equals(s.stageCode())
                && isSuccessful(s.status())).findFirst()
            .orElseThrow(() -> new ProcessingLifecycleConflictException("Transcript finalization has not succeeded."));
        if (evidence == null || !finalized.id().equals(evidence.finalizationStageId())
                || !List.of("READY", "READY_WITH_WARNINGS").contains(evidence.status())) {
            throw new ProcessingLifecycleConflictException("Canonical transcript evidence for latest finalization is required.");
        }
        if (evidence.suspicious() && "READY".equals(evidence.status())) {
            throw new ProcessingLifecycleConflictException("Unresolved transcript quality cannot be marked READY.");
        }
        boolean withWarnings = "READY_WITH_WARNINGS".equals(evidence.status())
            || stages.stream().anyMatch(s -> "SUCCEEDED_WITH_WARNING".equals(s.status()));
        String outcome = withWarnings ? "COMPLETED_WITH_WARNINGS" : "COMPLETED";
        String summary = withWarnings ? "Processing completed with transcript or stage quality warnings." : null;
        int changed = this.jdbc.update("""
            UPDATE processing_jobs SET status = ?, warning_summary = ?, retryable = FALSE,
              error_code = NULL, error_summary = NULL, completed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP, version = version + 1
            WHERE id = ? AND status = 'RUNNING'
            """, outcome, summary, jobId);
        if (changed != 1) throw new ProcessingLifecycleConflictException("Processing job is no longer running.");
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

    private boolean hasCorrectionPlan(UUID jobId) {
        return !latestAttempt(jobId, "CONTEXTUAL_CORRECTION").isEmpty();
    }

    private boolean hasSuccessfulContextualCorrection(UUID jobId) {
        return latestAttempt(jobId, "CONTEXTUAL_CORRECTION").stream()
            .anyMatch(attempt -> isSuccessful(attempt.status()) && Boolean.TRUE.equals(
                this.jdbc.queryForObject("""
                    SELECT metrics->>'contextScope'='WHOLE_MEETING'
                      AND metrics->>'outputSha256' ~ '^[0-9a-f]{64}$'
                    FROM processing_stage_runs WHERE id=?
                    """, Boolean.class, attempt.id())));
    }

    /** Immutable owner identity; the transcript port verifies persisted evidence. */
    /** Resolve stage and job owner without trusting the worker-supplied meeting. */
    public com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.DerivedStage derivedStage(UUID stageRunId) {
        return jdbc.query("""
            SELECT j.id AS job_id,j.meeting_id,j.source_media_id,s.stage_code
            FROM processing_stage_runs s JOIN processing_jobs j ON j.id=s.processing_job_id
            WHERE s.id=?
            """, (rs,n) -> new com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.DerivedStage(
                rs.getObject("job_id", UUID.class),rs.getObject("meeting_id", UUID.class),
                rs.getObject("source_media_id", UUID.class),rs.getString("stage_code")),stageRunId)
            .stream().findFirst().orElseThrow(() ->
                new ProcessingLifecycleConflictException("Unknown derived-stage attempt."));
    }

    public StageIdentity stageIdentity(UUID stageRunId) {
        return this.jdbc.query("""
            SELECT processing_job_id, stage_code FROM processing_stage_runs WHERE id=?
            """, (rs, row) -> new StageIdentity(rs.getObject("processing_job_id", UUID.class),
                rs.getString("stage_code")), stageRunId).stream().findFirst()
            .orElseThrow(() -> new IllegalArgumentException("Stage attempt does not exist."));
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

    /**
     * A job-scoped reference keeps stage_run_id NULL, but the worker must still
     * own an active stage claim. Matching references are idempotent, including NULL.
     */
    public void recordArtifact(UUID jobId, StageClaim producer, boolean jobScoped,
            String artifactType, String objectKey, String sha256, Long sizeBytes,
            String retentionClass) {
        String status = lockJobStatus(jobId);
        if (!"RUNNING".equals(status) || !isLatestClaim(jobId, producer) || !liveClaim(producer)) {
            throw new ProcessingLifecycleConflictException("Stale worker cannot record stage artifacts.");
        }
        UUID stageRunId = jobScoped ? null : producer.stageRunId();
        int inserted = this.jdbc.update("""
            INSERT INTO processing_artifacts (id, processing_job_id, stage_run_id, artifact_type,
              object_key, sha256, size_bytes, retention_class)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (object_key) DO NOTHING
            """, UUID.randomUUID(), jobId, stageRunId, artifactType, objectKey,
            sha256, sizeBytes, retentionClass);
        if (inserted == 1) return;
        boolean replay = Boolean.TRUE.equals(this.jdbc.queryForObject("""
            SELECT EXISTS (SELECT 1 FROM processing_artifacts WHERE object_key = ?
              AND processing_job_id = ? AND stage_run_id IS NOT DISTINCT FROM ?
              AND artifact_type = ? AND sha256 = ? AND size_bytes = ?
              AND retention_class IS NOT DISTINCT FROM ?)
            """, Boolean.class, objectKey, jobId, stageRunId, artifactType,
            sha256, sizeBytes, retentionClass));
        if (!replay) {
            throw new ProcessingLifecycleConflictException("Artifact reference conflicts with existing provenance.");
        }
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

    /**
     * Recover orphaned worker claims with the same job-first lock ordering used
     * by stage operations. A timed-out attempt becomes retryable FAILED; a new
     * attempt is admitted only through the bounded retry API.
     */
    @Transactional
    public int expireAbandonedStages(int limit) {
        if (limit < 1) throw new IllegalArgumentException("Stage sweep limit must be positive.");
        List<UUID> jobs = this.jdbc.query("""
            SELECT j.id FROM processing_jobs j WHERE j.status = 'RUNNING'
              AND EXISTS (SELECT 1 FROM processing_stage_runs s
                WHERE s.processing_job_id = j.id AND s.status = 'RUNNING'
                  AND (s.lease_expires_at IS NULL OR s.lease_expires_at <= clock_timestamp()))
            ORDER BY j.updated_at, j.id LIMIT ? FOR UPDATE OF j SKIP LOCKED
            """, (rs, row) -> rs.getObject("id", UUID.class), limit);
        int failed = 0;
        for (UUID jobId : jobs) {
            List<UUID> expired = this.jdbc.query("""
                SELECT id FROM processing_stage_runs
                WHERE processing_job_id = ? AND status = 'RUNNING'
                  AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
                FOR UPDATE
                """, (rs, row) -> rs.getObject("id", UUID.class), jobId);
            if (expired.isEmpty()) continue;
            this.jdbc.update("""
                UPDATE processing_stage_runs SET status = 'FAILED', retryable = TRUE,
                  error_code = 'STAGE_LEASE_EXPIRED', completed_at = CURRENT_TIMESTAMP
                WHERE processing_job_id = ? AND status = 'RUNNING'
                  AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
                """, jobId);
            this.jdbc.update("""
                UPDATE processing_jobs SET status = 'FAILED', retryable = TRUE,
                  error_code = 'STAGE_LEASE_EXPIRED',
                  error_summary = 'Processing worker stopped reporting progress.',
                  completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
                  version = version + 1
                WHERE id = ? AND status = 'RUNNING'
                """, jobId);
            failed++;
        }
        return failed;
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
        // Job-level retry continues at the failed stage; successful stages stay intact.
        String resumeStage = stageCode != null ? stageCode
            : (job.currentStage() != null && hasRetryableFailedStage(job.id(), job.currentStage())
                ? job.currentStage() : null);
        int updated = this.jdbc.update("""
            UPDATE processing_jobs SET status = 'PENDING', current_stage = COALESCE(?, current_stage),
              queued_at = NULL, completed_at = NULL, error_code = NULL, error_summary = NULL,
              retryable = FALSE, retry_count = retry_count + 1,
              updated_at = CURRENT_TIMESTAMP, version = version + 1
            WHERE id = ? AND status = 'FAILED'
              AND retry_count = ? AND retry_count < ?
              AND (
                (? = FALSE AND retryable = TRUE)
                OR (? = TRUE AND EXISTS (
                  SELECT 1 FROM processing_stage_runs s
                  WHERE s.processing_job_id = processing_jobs.id AND s.stage_code = ?
                    AND s.status = 'FAILED' AND s.retryable = TRUE
                    AND s.attempt_number = (
                      SELECT MAX(x.attempt_number) FROM processing_stage_runs x
                      WHERE x.processing_job_id = s.processing_job_id AND x.stage_code = s.stage_code)
                ))
              )
            """, resumeStage, job.id(), job.retryCount(), maxRetries,
            stageCode != null, stageCode != null, stageCode);
        if (updated != 1) return false;
        if (resumeStage != null) {
            int inserted = this.jdbc.update("""
                INSERT INTO processing_stage_runs (id, processing_job_id, stage_code, attempt_number,
                  status, retryable, created_at)
                SELECT ?, ?, ?, COALESCE(MAX(attempt_number), 0) + 1, 'PENDING', FALSE, CURRENT_TIMESTAMP
                FROM processing_stage_runs WHERE processing_job_id = ? AND stage_code = ?
                """, UUID.randomUUID(), job.id(), resumeStage, job.id(), resumeStage);
            if (inserted != 1) throw new IllegalStateException("Could not create the retry stage attempt.");
        }
        String payload;
        try {
            payload = this.mapper.writeValueAsString(new JobRetryEvent(eventId, job.id(), job.meetingId(),
                job.sourceMediaId(), job.requestedBy(), resumeStage, job.retryCount() + 1,
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
              UPDATE processing_jobs p SET status = 'FAILED', retryable = TRUE,
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
              UPDATE processing_jobs p SET status = 'FAILED', retryable = TRUE,
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
    public record StageIdentity(UUID jobId, String stageCode) { }
    private record StageCompletion(UUID id, String stageCode, String status) { }
    private record FinalizationState(String jobStatus, String stageStatus, String stageCode,
            String mediaStatus) { }
    private record StageAttempt(UUID id, int attemptNumber, String status) { }
    private record StageJob(UUID jobId, String stageCode, String status) { }
    public record PendingCleanup(UUID id, String pendingObjectKey) { }
    public record Outbox(UUID id, String eventType, String payload, int attemptCount, UUID claimToken) { }
    public record JobQueuedEvent(UUID eventId, UUID processingJobId, UUID meetingId, UUID sourceMediaId,
            UUID requestedByUserId, String requestId, int schemaVersion, OffsetDateTime occurredAt) { }
    public record JobRetryEvent(UUID eventId, UUID processingJobId, UUID meetingId, UUID sourceMediaId,
            UUID requestedByUserId, String retryFromStage, int attemptNumber, String requestId,
            int schemaVersion, OffsetDateTime occurredAt) { }

    /** Domain-level lifecycle conflict, distinct from an invalid JDBC operation. */
    public static class ProcessingLifecycleConflictException extends RuntimeException {
        public ProcessingLifecycleConflictException(String reason) { super(reason); }
    }

    public static class IdempotencyConflictException extends RuntimeException { }
    public static class JobAdmissionConflictException extends RuntimeException { }
}
