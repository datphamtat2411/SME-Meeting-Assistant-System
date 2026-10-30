package com.sme.meetingassistant.api.media;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.repository.MediaRepository.Job;
import com.sme.meetingassistant.api.media.repository.MediaRepository.ProcessingLifecycleConflictException;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.support.TransactionTemplate;

@ActiveProfiles("test")
@SpringBootTest(properties = {
    "app.media.outbox.enabled=false",
    "app.media.processing.stage-lease-seconds=60",
    "app.media.processing.stage-lease-sweep-ms=3600000"
})
@Import(PostgresTestConfiguration.class)
class ProcessingStageFencingIntegrationTests {
    @Autowired ProcessingJobLifecycle lifecycle;
    @Autowired MediaRepository repository;
    @Autowired JdbcTemplate jdbc;
    @Autowired TransactionTemplate transactions;
    private UUID jobId;

    @BeforeEach
    void setUp() {
        UUID actor = UUID.randomUUID(), meetingId = UUID.randomUUID(), mediaId = UUID.randomUUID();
        jobId = UUID.randomUUID();
        String email = "stage-fence-" + actor + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Stage fencing','test-only','EMPLOYEE','ACTIVE')
            """, actor, email, email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Stage fencing',?,?)
            """, meetingId, actor, actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',512,512,10000,?,CURRENT_TIMESTAMP)
            """, mediaId, meetingId, "meetings/" + meetingId + "/sources/" + mediaId,
            "meetings/" + meetingId + "/pending/" + mediaId, actor);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status,queued_at)
            VALUES (?,?,?,?,'QUEUED',CURRENT_TIMESTAMP)
            """, jobId, meetingId, mediaId, actor);
    }

    private StageClaim start() {
        return lifecycle.startStage(jobId, "TRANSCRIPTION", "whisper", "base");
    }

    private String status() {
        return jdbc.queryForObject("SELECT status FROM processing_jobs WHERE id=?", String.class, jobId);
    }

    private void expire(StageClaim claim) {
        jdbc.update("UPDATE processing_stage_runs SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id=?",
            claim.stageRunId());
    }

    private boolean retry(Job snapshot, UUID event) {
        return Boolean.TRUE.equals(transactions.execute(status ->
            repository.retryJobAndOutbox(snapshot, event, "TRANSCRIPTION", 3)));
    }

    @Test
    void twoConcurrentWorkersCanOnlyClaimOneActiveStage() throws Exception {
        try (var pool = Executors.newFixedThreadPool(2)) {
            var gate = new CountDownLatch(1);
            var a = pool.submit(() -> { gate.await(); return start(); });
            var b = pool.submit(() -> { gate.await(); return start(); });
            gate.countDown();
            int won = 0, rejected = 0;
            for (var f : java.util.List.of(a, b)) {
                try { assertThat(f.get(15, TimeUnit.SECONDS).claimToken()).isNotNull(); won++; }
                catch (java.util.concurrent.ExecutionException e) {
                    assertThat(e.getCause()).isInstanceOf(ProcessingLifecycleConflictException.class);
                    rejected++;
                }
            }
            assertThat(won).isEqualTo(1);
            assertThat(rejected).isEqualTo(1);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM processing_stage_runs WHERE processing_job_id=?
                """, Integer.class, jobId)).isEqualTo(1);
        }
    }

    @Test
    void competingDifferentStageIsRejectedWhileCurrentWorkerOwnsJob() {
        start();
        assertThatThrownBy(() -> lifecycle.startStage(jobId, "DIARIZING", null, null))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
    }

    @Test
    void anotherTokenCannotRenewCompleteFailOrWriteArtifacts() {
        StageClaim claim = start();
        StageClaim stolen = new StageClaim(claim.stageRunId(), UUID.randomUUID());
        assertThatThrownBy(() -> lifecycle.renewStageLease(stolen))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThatThrownBy(() -> lifecycle.completeStage(stolen, "SUCCEEDED", null, null))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThatThrownBy(() -> lifecycle.failStage(stolen, "FAILED_STAGE", "stolen", true))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThatThrownBy(() -> lifecycle.recordArtifact(jobId, stolen, "NORMALIZED_AUDIO",
            "processing/" + jobId + "/artifacts/" + UUID.randomUUID() + ".wav",
            "a".repeat(64), 1L, "TEMPORARY"))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThat(status()).isEqualTo("RUNNING");
        lifecycle.completeStage(claim, "SUCCEEDED", null, "{}");
    }

    @Test
    void leaseHeartbeatRenewsOnlyCurrentUnexpiredOwner() {
        StageClaim claim = start();
        jdbc.update("""
            UPDATE processing_stage_runs SET lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '2 seconds'
            WHERE id=?
            """, claim.stageRunId());
        lifecycle.renewStageLease(claim);
        assertThat(jdbc.queryForObject("""
            SELECT lease_expires_at > CURRENT_TIMESTAMP + INTERVAL '30 seconds'
            FROM processing_stage_runs WHERE id=?
            """, Boolean.class, claim.stageRunId())).isTrue();
        lifecycle.completeStage(claim, "SUCCEEDED", null, null);
        assertThatThrownBy(() -> lifecycle.renewStageLease(claim))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
    }

    @Test
    void expiredOwnerCannotReportSuccessAndIsMarkedRetryable() {
        StageClaim claim = start();
        expire(claim);
        assertThatThrownBy(() -> lifecycle.completeStage(claim, "SUCCEEDED", null, null))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThatThrownBy(() -> lifecycle.renewStageLease(claim))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThat(repository.expireAbandonedStages(25)).isEqualTo(1);
        assertThat(status()).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("""
            SELECT error_code FROM processing_stage_runs WHERE id=?
            """, String.class, claim.stageRunId())).isEqualTo("STAGE_LEASE_EXPIRED");
        assertThatThrownBy(() -> lifecycle.failStage(claim, "LATE", "stale", true))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
    }

    @Test
    void manualRetryCreatesNewStageClaimAndFencesOldWorker() {
        StageClaim old = start();
        lifecycle.failStage(old, "TEMPORARY_FAILURE", "retryable", true);
        Job snapshot = repository.findJob(jobId).orElseThrow();
        assertThat(retry(snapshot, UUID.randomUUID())).isTrue();
        StageClaim fresh = start();
        assertThat(fresh.stageRunId()).isNotEqualTo(old.stageRunId());
        assertThat(fresh.claimToken()).isNotEqualTo(old.claimToken());
        assertThat(jdbc.queryForObject("""
            SELECT attempt_number FROM processing_stage_runs WHERE id=?
            """, Integer.class, fresh.stageRunId())).isEqualTo(2);
        assertThatThrownBy(() -> lifecycle.completeStage(old, "SUCCEEDED", null, null))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        assertThatThrownBy(() -> lifecycle.renewStageLease(old))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        lifecycle.completeStage(fresh, "SUCCEEDED", null, null);
    }

    @Test
    void racingRetryRequestsAdmitExactlyOneGeneration() throws Exception {
        StageClaim failed = start();
        lifecycle.failStage(failed, "TEMPORARY_FAILURE", "retryable", true);
        Job snapshot = repository.findJob(jobId).orElseThrow();
        try (var pool = Executors.newFixedThreadPool(2)) {
            var gate = new CountDownLatch(1);
            var f1 = pool.submit(() -> { gate.await(); return retry(snapshot, UUID.randomUUID()); });
            var f2 = pool.submit(() -> { gate.await(); return retry(snapshot, UUID.randomUUID()); });
            gate.countDown();
            assertThat(new ArrayList<>(java.util.List.of(
                f1.get(15, TimeUnit.SECONDS), f2.get(15, TimeUnit.SECONDS))))
                .containsExactlyInAnyOrder(true, false);
        }
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM outbox_events WHERE aggregate_id=?
              AND event_type='PROCESSING_JOB_RETRY_REQUESTED'
            """, Integer.class, jobId)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM processing_stage_runs
              WHERE processing_job_id=? AND stage_code='TRANSCRIPTION'
            """, Integer.class, jobId)).isEqualTo(2);
        assertThat(repository.findJob(jobId).orElseThrow().retryCount()).isEqualTo(1);
    }

    @Test
    void jobLevelRetryResumesFailedStageWithoutDuplicatingSuccessfulWork() {
        StageClaim first = start();
        lifecycle.failStage(first, "TRANSCRIPTION_TEMPORARY", "Transient failure", true);
        Job failed = repository.findJob(jobId).orElseThrow();
        assertThat(Boolean.TRUE.equals(transactions.execute(status ->
            repository.retryJobAndOutbox(failed, UUID.randomUUID(), null, 3)))).isTrue();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM processing_stage_runs WHERE processing_job_id=?
              AND stage_code='TRANSCRIPTION'
            """, Integer.class, jobId)).isEqualTo(2);
        StageClaim resumed = start();
        assertThat(resumed.stageRunId()).isNotEqualTo(first.stageRunId());
        assertThatThrownBy(() -> lifecycle.completeStage(first, "SUCCEEDED", null, null))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
        lifecycle.completeStage(resumed, "SUCCEEDED", null, null);
    }

    @Test
    void staleFailedSnapshotCannotCreateAnotherRetryAfterGenerationChanges() {
        StageClaim failed = start();
        lifecycle.failStage(failed, "TEMPORARY_FAILURE", "retryable", true);
        Job stale = repository.findJob(jobId).orElseThrow();
        assertThat(retry(stale, UUID.randomUUID())).isTrue();
        jdbc.update("""
            UPDATE processing_jobs SET status='FAILED', retryable=TRUE WHERE id=?
            """, jobId);
        assertThat(retry(stale, UUID.randomUUID())).isFalse();
        assertThat(repository.findJob(jobId).orElseThrow().retryCount()).isEqualTo(1);
    }

    @Test
    void originalWorkerCannotCreateArtifactsAfterLeaseExpires() {
        StageClaim owner = start();
        expire(owner);
        assertThatThrownBy(() -> lifecycle.recordArtifact(jobId, owner, "NORMALIZED_AUDIO",
            "processing/" + jobId + "/artifacts/" + UUID.randomUUID() + ".wav",
            "a".repeat(64), 1L, "TEMPORARY"))
            .isInstanceOf(ProcessingLifecycleConflictException.class);
    }
}
