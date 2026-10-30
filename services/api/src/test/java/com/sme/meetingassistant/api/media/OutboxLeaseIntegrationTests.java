package com.sme.meetingassistant.api.media;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.repository.MediaRepository.Outbox;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.util.List;
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

@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class OutboxLeaseIntegrationTests {
    @Autowired MediaRepository repository;
    @Autowired JdbcTemplate jdbc;
    private UUID eventId;

    @BeforeEach
    void setUp() {
        eventId = UUID.randomUUID();
        // Older than all real test-created events: deterministic claim order.
        jdbc.update("""
            INSERT INTO outbox_events(id, aggregate_type, aggregate_id, event_type, payload,
                occurred_at, next_attempt_at)
            VALUES (?, 'PROCESSING_JOB', ?, 'PROCESSING_JOB_QUEUED',
                '{"schemaVersion":1}'::jsonb, '2020-01-01', '2020-01-01')
            """, eventId, UUID.randomUUID());
    }

    private Outbox claim() {
        List<Outbox> claims = repository.claimPendingOutbox(1, 60, 3);
        assertThat(claims).hasSize(1);
        assertThat(claims.get(0).id()).isEqualTo(eventId);
        return claims.get(0);
    }

    private String status() {
        return jdbc.queryForObject("SELECT status FROM outbox_events WHERE id = ?",
            String.class, eventId);
    }

    @Test
    void oneClaimExcludesASecondPublisherUntilLeaseExpires() {
        Outbox first = claim();
        assertThat(first.attemptCount()).isEqualTo(1);
        assertThat(repository.claimPendingOutbox(1, 60, 3)).noneMatch(e -> e.id().equals(eventId));
        assertThat(repository.markPublished(eventId, UUID.randomUUID())).isFalse();
        assertThat(repository.markPublishFailed(eventId, UUID.randomUUID(), 1, 3, "stale")).isFalse();
        assertThat(status()).isEqualTo("PENDING");
        assertThat(repository.markPublished(eventId, first.claimToken())).isTrue();
        assertThat(status()).isEqualTo("PUBLISHED");
        assertThat(repository.claimPendingOutbox(1, 60, 3)).noneMatch(e -> e.id().equals(eventId));
    }

    @Test
    void expiredLeaseIsRecoveredButLateConfirmCannotMarkNewClaimPublished() {
        Outbox first = claim();
        jdbc.update("UPDATE outbox_events SET claim_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = ?",
            eventId);
        Outbox second = claim();
        assertThat(second.claimToken()).isNotEqualTo(first.claimToken());
        assertThat(second.attemptCount()).isEqualTo(2);
        assertThat(repository.markPublished(eventId, first.claimToken())).isFalse();
        assertThat(repository.markPublishFailed(eventId, first.claimToken(), 1, 3, "stale")).isFalse();
        assertThat(repository.markPublished(eventId, second.claimToken())).isTrue();
        assertThat(status()).isEqualTo("PUBLISHED");
    }

    @Test
    void failureBackoffAndTerminalExhaustionAreDurable() {
        Outbox first = claim();
        assertThat(repository.markPublishFailed(eventId, first.claimToken(), 1, 3, "nack")).isTrue();
        assertThat(status()).isEqualTo("PENDING");
        assertThat(repository.claimPendingOutbox(1, 60, 3)).noneMatch(e -> e.id().equals(eventId));
        jdbc.update("UPDATE outbox_events SET next_attempt_at = '2020-01-01' WHERE id = ?", eventId);
        Outbox second = claim();
        assertThat(repository.markPublishFailed(eventId, second.claimToken(), 2, 3, "nack")).isTrue();
        jdbc.update("UPDATE outbox_events SET next_attempt_at = '2020-01-01' WHERE id = ?", eventId);
        Outbox third = claim();
        assertThat(repository.markPublishFailed(eventId, third.claimToken(), 3, 3, "nack")).isTrue();
        assertThat(status()).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("SELECT attempt_count FROM outbox_events WHERE id = ?",
            Integer.class, eventId)).isEqualTo(3);
    }

    @Test
    void crashAfterFinalAttemptEventuallyMarksOutboxFailedWithoutSendingAgain() {
        Outbox first = claim();
        jdbc.update("UPDATE outbox_events SET claim_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = ?",
            eventId);
        Outbox second = claim();
        jdbc.update("UPDATE outbox_events SET claim_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = ?",
            eventId);
        Outbox third = claim();
        jdbc.update("UPDATE outbox_events SET claim_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = ?",
            eventId);
        assertThat(repository.claimPendingOutbox(1, 60, 3)).noneMatch(e -> e.id().equals(eventId));
        assertThat(status()).isEqualTo("FAILED");
        assertThat(third.attemptCount()).isEqualTo(3);
        assertThat(first.id()).isEqualTo(second.id());
    }

    @Test
    void twoConcurrentWorkersCanNeverClaimTheSamePendingRow() throws Exception {
        try (var pool = Executors.newFixedThreadPool(2)) {
            var gate = new CountDownLatch(1);
            var f1 = pool.submit(() -> {
                gate.await();
                return repository.claimPendingOutbox(1, 60, 3);
            });
            var f2 = pool.submit(() -> {
                gate.await();
                return repository.claimPendingOutbox(1, 60, 3);
            });
            gate.countDown();
            var all = new java.util.ArrayList<Outbox>();
            all.addAll(f1.get(20, TimeUnit.SECONDS));
            all.addAll(f2.get(20, TimeUnit.SECONDS));
            assertThat(all).hasSize(1);
            assertThat(all.get(0).id()).isEqualTo(eventId);
        }
    }
}
