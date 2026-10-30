package com.sme.meetingassistant.api.media;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.repository.MediaRepository.Outbox;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

/** T06: outbox dispatch decision and job status must commit atomically. */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class ProcessingDispatchStateIntegrationTests {
    @Autowired MediaRepository repository;
    @Autowired JdbcTemplate jdbc;
    private UUID eventId;
    private UUID jobId;

    @BeforeEach
    void fixture() {
        UUID userId = UUID.randomUUID();
        UUID meetingId = UUID.randomUUID();
        UUID mediaId = UUID.randomUUID();
        jobId = UUID.randomUUID();
        eventId = UUID.randomUUID();
        String email = "t06-" + userId + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'T06 actor','test-only','EMPLOYEE','ACTIVE')
            """, userId, email, email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'T06 dispatch test',?,?)
            """, meetingId, userId, userId);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                original_filename,content_type,expected_size_bytes,size_bytes,duration_ms,sha256,
                uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'recording.wav','audio/wav',
                512,512,1000,?,?,CURRENT_TIMESTAMP)
            """, mediaId, meetingId, "meetings/" + meetingId + "/sources/" + mediaId,
            "meetings/" + meetingId + "/pending/" + mediaId, "a".repeat(64), userId);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,
                status,queued_at)
            VALUES (?,?,?,?,'PENDING',NULL)
            """, jobId, meetingId, mediaId, userId);
        // Prefer this event over unrelated outbox fixtures from other test classes.
        jdbc.update("""
            INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,
                occurred_at,next_attempt_at)
            VALUES (?,'PROCESSING_JOB',?,'PROCESSING_JOB_QUEUED',
                '{"schemaVersion":1}'::jsonb,'1900-01-01','1900-01-01')
            """, eventId, jobId);
    }

    private Outbox claim(int maxAttempts) {
        var events = repository.claimPendingOutbox(1, 60, maxAttempts);
        assertThat(events).hasSize(1);
        assertThat(events.get(0).id()).isEqualTo(eventId);
        return events.get(0);
    }

    private String jobStatus() {
        return jdbc.queryForObject("SELECT status FROM processing_jobs WHERE id = ?", String.class, jobId);
    }

    private String outboxStatus() {
        return jdbc.queryForObject("SELECT status FROM outbox_events WHERE id = ?", String.class, eventId);
    }

    @Test
    void admittedJobRemainsPendingUntilConfirmedDelivery() {
        assertThat(jobStatus()).isEqualTo("PENDING");
        assertThat(repository.findJob(jobId).orElseThrow().queuedAt()).isNull();
        Outbox claim = claim(3);
        assertThat(jobStatus()).isEqualTo("PENDING");
        assertThat(repository.markPublished(eventId, claim.claimToken())).isTrue();
        assertThat(jobStatus()).isEqualTo("QUEUED");
        assertThat(outboxStatus()).isEqualTo("PUBLISHED");
        assertThat(repository.findJob(jobId).orElseThrow().queuedAt()).isNotNull();
        assertThat(repository.markPublished(eventId, claim.claimToken())).isFalse();
    }

    @Test
    void transientFailureKeepsJobPendingAndTerminalNackFailsIt() {
        Outbox first = claim(2);
        assertThat(repository.markPublishFailed(eventId, first.claimToken(), 1, 2, "nack")).isTrue();
        assertThat(jobStatus()).isEqualTo("PENDING");
        assertThat(outboxStatus()).isEqualTo("PENDING");
        jdbc.update("UPDATE outbox_events SET next_attempt_at = '1900-01-01' WHERE id = ?", eventId);
        Outbox second = claim(2);
        assertThat(repository.markPublishFailed(eventId, second.claimToken(), 2, 2, "nack")).isTrue();
        assertThat(outboxStatus()).isEqualTo("FAILED");
        assertThat(jobStatus()).isEqualTo("FAILED");
        assertThat(repository.findJob(jobId).orElseThrow().retryable()).isTrue();
        assertThat(jdbc.queryForObject("SELECT error_code FROM processing_jobs WHERE id = ?",
            String.class, jobId)).isEqualTo("JOB_DISPATCH_FAILED");
        assertThat(repository.findJob(jobId).orElseThrow().completedAt()).isNotNull();
        assertThat(repository.findJob(jobId).orElseThrow().queuedAt()).isNull();
    }

    @Test
    void crashedPublisherAtLastAttemptIsReconciledByNextPoll() {
        Outbox first = claim(2);
        jdbc.update("""
            UPDATE outbox_events SET claim_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
            WHERE id = ?
            """, eventId);
        Outbox last = claim(2);
        assertThat(last.attemptCount()).isEqualTo(2);
        jdbc.update("""
            UPDATE outbox_events SET claim_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
            WHERE id = ?
            """, eventId);
        assertThat(repository.claimPendingOutbox(1, 60, 2)).noneMatch(e -> e.id().equals(eventId));
        assertThat(outboxStatus()).isEqualTo("FAILED");
        assertThat(jobStatus()).isEqualTo("FAILED");
        assertThat(repository.findJob(jobId).orElseThrow().retryable()).isTrue();
        assertThat(repository.markPublished(eventId, first.claimToken())).isFalse();
        assertThat(repository.markPublished(eventId, last.claimToken())).isFalse();
    }

    @Test
    void terminalDispatchFailureCanRetryOriginalJobWithoutCreatingFakeStage() {
        Outbox first = claim(1);
        assertThat(repository.markPublishFailed(eventId, first.claimToken(), 1, 1, "broker-down")).isTrue();
        var failed = repository.findJob(jobId).orElseThrow();
        assertThat(failed.retryable()).isTrue();
        UUID retryEvent = UUID.randomUUID();
        assertThat(repository.retryJobAndOutbox(failed, retryEvent, null, 2)).isTrue();
        assertThat(jobStatus()).isEqualTo("PENDING");
        assertThat(repository.findJob(jobId).orElseThrow().retryCount()).isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM processing_stage_runs WHERE processing_job_id=?", Integer.class, jobId))
            .isZero();
        // The old failed event stays terminal; only the new generation is dispatched.
        assertThat(repository.markPublished(eventId, first.claimToken())).isFalse();
        eventId = retryEvent;
        jdbc.update("""
            UPDATE outbox_events SET occurred_at='1900-01-01', next_attempt_at='1900-01-01'
            WHERE id=?
            """, retryEvent);
        Outbox retried = claim(1);
        assertThat(retried.eventType()).isEqualTo("PROCESSING_JOB_RETRY_REQUESTED");
        assertThat(repository.markPublished(retryEvent, retried.claimToken())).isTrue();
        assertThat(jobStatus()).isEqualTo("QUEUED");
        assertThat(repository.findJob(jobId).orElseThrow().retryable()).isFalse();
    }

    @Test
    void lateConfirmAndFailureCannotChangeStateUnderAnotherLease() {
        Outbox stale = claim(3);
        jdbc.update("""
            UPDATE outbox_events SET claim_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
            WHERE id = ?
            """, eventId);
        Outbox current = claim(3);
        assertThat(repository.markPublished(eventId, stale.claimToken())).isFalse();
        assertThat(repository.markPublishFailed(eventId, stale.claimToken(), 1, 3, "late")).isFalse();
        assertThat(jobStatus()).isEqualTo("PENDING");
        assertThat(outboxStatus()).isEqualTo("PENDING");
        assertThat(repository.markPublished(eventId, current.claimToken())).isTrue();
        assertThat(jobStatus()).isEqualTo("QUEUED");
    }

    @Test
    void brokerConfirmCannotDowngradeJobAlreadyRunning() {
        Outbox claim = claim(2);
        jdbc.update("""
            UPDATE processing_jobs SET status = 'RUNNING', queued_at = CURRENT_TIMESTAMP,
                started_at = CURRENT_TIMESTAMP WHERE id = ?
            """, jobId);
        assertThat(repository.markPublished(eventId, claim.claimToken())).isTrue();
        assertThat(jobStatus()).isEqualTo("RUNNING");
        assertThat(outboxStatus()).isEqualTo("PUBLISHED");
    }

    @Test
    void exhaustedOutboxCannotEraseAlreadyRunningConsumerProgress() {
        Outbox claim = claim(1);
        jdbc.update("""
            UPDATE processing_jobs SET status = 'RUNNING', queued_at = CURRENT_TIMESTAMP,
                started_at = CURRENT_TIMESTAMP WHERE id = ?
            """, jobId);
        assertThat(repository.markPublishFailed(eventId, claim.claimToken(), 1, 1, "no-confirm")).isTrue();
        assertThat(outboxStatus()).isEqualTo("FAILED");
        assertThat(jobStatus()).isEqualTo("RUNNING");
        assertThat(repository.findJob(jobId).orElseThrow().errorCode()).isNull();
    }

    @Test
    void crashReconciliationCannotEraseAlreadyCompletedJob() {
        Outbox claim = claim(1);
        jdbc.update("""
            UPDATE processing_jobs SET status = 'COMPLETED',
                queued_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """, jobId);
        jdbc.update("""
            UPDATE outbox_events SET claim_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
            WHERE id = ?
            """, eventId);
        assertThat(repository.claimPendingOutbox(1, 60, 1)).noneMatch(e -> e.id().equals(eventId));
        assertThat(outboxStatus()).isEqualTo("FAILED");
        assertThat(jobStatus()).isEqualTo("COMPLETED");
        assertThat(repository.findJob(jobId).orElseThrow().errorCode()).isNull();
    }

    private UUID scheduleRetry() {
        // Only the retry dispatch should remain claimable for the fixture.
        jdbc.update("UPDATE outbox_events SET status = 'PUBLISHED' WHERE id = ?", eventId);
        jdbc.update("""
            UPDATE processing_jobs SET status = 'FAILED', retryable = TRUE,
                completed_at = CURRENT_TIMESTAMP WHERE id = ?
            """, jobId);
        UUID retryEventId = UUID.randomUUID();
        assertThat(repository.retryJobAndOutbox(
            repository.findJob(jobId).orElseThrow(), retryEventId, null, 3)).isTrue();
        eventId = retryEventId;
        assertThat(jobStatus()).isEqualTo("PENDING");
        assertThat(repository.findJob(jobId).orElseThrow().retryCount()).isEqualTo(1);
        return retryEventId;
    }

    @Test
    void confirmedRetryDispatchQueuesThePendingJob() {
        UUID retryEventId = scheduleRetry();
        Outbox retry = claim(3);
        assertThat(retry.eventType()).isEqualTo("PROCESSING_JOB_RETRY_REQUESTED");
        assertThat(repository.markPublished(retryEventId, retry.claimToken())).isTrue();
        assertThat(outboxStatus()).isEqualTo("PUBLISHED");
        assertThat(jobStatus()).isEqualTo("QUEUED");
        assertThat(repository.findJob(jobId).orElseThrow().queuedAt()).isNotNull();
    }

    @Test
    void terminalRetryPublishFailureFailsJobRatherThanLeavingItPending() {
        UUID retryEventId = scheduleRetry();
        Outbox retry = claim(1);
        assertThat(repository.markPublishFailed(retryEventId, retry.claimToken(),
            1, 1, "broker-nack")).isTrue();
        assertThat(outboxStatus()).isEqualTo("FAILED");
        assertThat(jobStatus()).isEqualTo("FAILED");
        assertThat(repository.findJob(jobId).orElseThrow().errorCode())
            .isEqualTo("JOB_DISPATCH_FAILED");
        assertThat(repository.findJob(jobId).orElseThrow().retryable()).isTrue();
    }

    @Test
    void expiredFinalRetryPublisherLeaseFailsItsPendingJob() {
        scheduleRetry();
        Outbox retry = claim(1);
        jdbc.update("""
            UPDATE outbox_events SET claim_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
            WHERE id = ?
            """, retry.id());
        assertThat(repository.claimPendingOutbox(1, 60, 1))
            .noneMatch(e -> e.id().equals(retry.id()));
        assertThat(outboxStatus()).isEqualTo("FAILED");
        assertThat(jobStatus()).isEqualTo("FAILED");
        assertThat(repository.findJob(jobId).orElseThrow().retryable()).isTrue();
    }

    @Test
    void lateInitialDispatchConfirmationCannotQueueNewRetryGeneration() {
        Outbox staleInitial = claim(3);
        jdbc.update("""
            UPDATE processing_jobs SET status = 'FAILED', retryable = TRUE,
                completed_at = CURRENT_TIMESTAMP WHERE id = ?
            """, jobId);
        UUID retryEventId = UUID.randomUUID();
        assertThat(repository.retryJobAndOutbox(
            repository.findJob(jobId).orElseThrow(), retryEventId, null, 3)).isTrue();
        // The initial event was consumed but its publisher acknowledgement arrived late.
        assertThat(repository.markPublished(eventId, staleInitial.claimToken())).isTrue();
        assertThat(jobStatus()).isEqualTo("PENDING");
        eventId = retryEventId;
        Outbox retry = claim(3);
        assertThat(repository.markPublished(retryEventId, retry.claimToken())).isTrue();
        assertThat(jobStatus()).isEqualTo("QUEUED");
    }

    @Test
    void staleRetryFailureCannotFailANewerRetryGeneration() {
        UUID oldRetryEvent = scheduleRetry();
        Outbox oldClaim = claim(1);
        jdbc.update("""
            UPDATE processing_jobs SET status = 'FAILED', retryable = TRUE,
                completed_at = CURRENT_TIMESTAMP WHERE id = ?
            """, jobId);
        UUID newRetryEvent = UUID.randomUUID();
        assertThat(repository.retryJobAndOutbox(
            repository.findJob(jobId).orElseThrow(), newRetryEvent, null, 3)).isTrue();
        assertThat(repository.findJob(jobId).orElseThrow().retryCount()).isEqualTo(2);
        assertThat(repository.markPublishFailed(oldRetryEvent, oldClaim.claimToken(),
            1, 1, "late-nack")).isTrue();
        assertThat(jobStatus()).isEqualTo("PENDING");
        assertThat(jdbc.queryForObject("SELECT status FROM outbox_events WHERE id = ?",
            String.class, oldRetryEvent)).isEqualTo("FAILED");
        eventId = newRetryEvent;
        Outbox current = claim(3);
        assertThat(repository.markPublished(newRetryEvent, current.claimToken())).isTrue();
        assertThat(jobStatus()).isEqualTo("QUEUED");
    }

    @Test
    void retryBrokerConfirmCannotDowngradeAlreadyRunningConsumer() {
        UUID retryEventId = scheduleRetry();
        Outbox retry = claim(3);
        jdbc.update("""
            UPDATE processing_jobs SET status = 'RUNNING', started_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """, jobId);
        assertThat(repository.markPublished(retryEventId, retry.claimToken())).isTrue();
        assertThat(jobStatus()).isEqualTo("RUNNING");
    }
}
