package com.sme.meetingassistant.api.assistant;

import java.sql.ResultSet;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.server.ResponseStatusException;

/**
 * PostgreSQL-backed Assistant admission. All methods that inspect or mutate
 * admission state require the caller's short transaction.
 */
@Service
final class AssistantAdmissionGuard {
    private static final String GLOBAL_LOCK = "assistant-admission|global";
    private static final int CONCURRENCY_RETRY_AFTER_SECONDS = 5;

    private final JdbcTemplate jdbc;
    private final AssistantAdmissionProperties properties;
    private final AssistantAdmissionMetrics metrics;
    private final int retentionSeconds;

    AssistantAdmissionGuard(JdbcTemplate jdbc, AssistantAdmissionProperties properties,
            AssistantAdmissionMetrics metrics) {
        this.jdbc = jdbc;
        this.properties = properties;
        this.metrics = metrics;
        this.retentionSeconds = Math.max(properties.askWindowSeconds(),
            properties.conversationCreationWindowSeconds());
    }

    /** Lock order: global admission -> user -> meeting -> conversation row. */
    void lockAskScope(UUID userId, UUID meetingId) {
        requireTransaction();
        persist(() -> {
            lock(GLOBAL_LOCK);
            lock("assistant-admission|user|" + userId);
            lock("assistant-admission|meeting|" + meetingId);
            prune(userId);
            return null;
        });
    }

    /** Conversation creation has no active capacity and needs only the user lock. */
    void lockConversationCreationScope(UUID userId) {
        requireTransaction();
        persist(() -> {
            lock("assistant-admission|user|" + userId);
            prune(userId);
            return null;
        });
    }

    void ensureAskQuota(UUID userId) {
        requireTransaction();
        WindowUsage usage = persist(() -> usage(userId, "ASK",
            properties.askWindowSeconds()));
        if (usage.used() >= properties.maxAskRequestsPerUser()) {
            reject(Reason.ASK_QUOTA, quotaRetryAfter(usage,
                properties.askWindowSeconds()));
        }
    }

    void ensureConversationCreationQuota(UUID userId) {
        requireTransaction();
        WindowUsage usage = persist(() -> usage(userId, "CONVERSATION_CREATE",
            properties.conversationCreationWindowSeconds()));
        if (usage.used() >= properties.maxConversationCreationsPerUser()) {
            reject(Reason.CONVERSATION_QUOTA, quotaRetryAfter(usage,
                properties.conversationCreationWindowSeconds()));
        }
    }

    /** Active turns are durable PROCESSING rows with an unexpired lease. */
    void ensureActiveCapacity(UUID userId, UUID meetingId) {
        requireTransaction();
        long userActive = persist(() -> activeForUser(userId));
        if (userActive >= properties.maxActiveTurnsPerUser()) {
            reject(Reason.USER_CONCURRENCY,
                activeRetryAfter("""
                    SELECT min(t.claim_expires_at) AS expires_at,
                           clock_timestamp() AS observed_at
                      FROM assistant_turns t
                      JOIN assistant_conversations c ON c.id=t.conversation_id
                     WHERE c.user_id=? AND t.state='PROCESSING'
                       AND t.claim_expires_at > clock_timestamp()
                    """, userId));
        }

        long meetingActive = persist(() -> activeForMeeting(meetingId));
        if (meetingActive >= properties.maxActiveTurnsPerMeeting()) {
            reject(Reason.MEETING_CONCURRENCY,
                activeRetryAfter("""
                    SELECT min(t.claim_expires_at) AS expires_at,
                           clock_timestamp() AS observed_at
                      FROM assistant_turns t
                      JOIN assistant_conversations c ON c.id=t.conversation_id
                     WHERE c.meeting_id=? AND t.state='PROCESSING'
                       AND t.claim_expires_at > clock_timestamp()
                    """, meetingId));
        }

        long globalActive = persist(this::activeGlobally);
        if (globalActive >= properties.maxActiveTurnsGlobal()) {
            reject(Reason.GLOBAL_CONCURRENCY,
                activeRetryAfter("""
                    SELECT min(claim_expires_at) AS expires_at,
                           clock_timestamp() AS observed_at
                      FROM assistant_turns
                     WHERE state='PROCESSING'
                       AND claim_expires_at > clock_timestamp()
                    """));
        }
    }

    /** Called only after the new durable turn row has been inserted. */
    void recordAsk(UUID userId, UUID turnId) {
        requireTransaction();
        persist(() -> {
            jdbc.update("""
                INSERT INTO assistant_admission_events(
                    id,user_id,event_type,turn_id,occurred_at)
                VALUES (?,?,'ASK',?,clock_timestamp())
                """, UUID.randomUUID(), userId, turnId);
            afterCommit(() -> metrics.accepted("ASK"));
            return null;
        });
    }

    /** Called only after the new durable conversation row has been inserted. */
    void recordConversationCreation(UUID userId, UUID conversationId) {
        requireTransaction();
        persist(() -> {
            jdbc.update("""
                INSERT INTO assistant_admission_events(
                    id,user_id,event_type,conversation_id,occurred_at)
                VALUES (?,?,'CONVERSATION_CREATE',?,clock_timestamp())
                """, UUID.randomUUID(), userId, conversationId);
            afterCommit(() -> metrics.accepted("CONVERSATION_CREATE"));
            return null;
        });
    }

    void replay() {
        requireTransaction();
        afterCommit(metrics::replayed);
    }

    void leaseExpired() {
        requireTransaction();
        afterCommit(metrics::leaseExpired);
    }

    void leaseReclaimed() {
        requireTransaction();
        afterCommit(metrics::leaseReclaimed);
    }

    void latency(String operation, long elapsedNanos) {
        metrics.latency(operation, elapsedNanos);
    }

    ResponseStatusException databaseUnavailable() {
        metrics.persistenceFailure();
        return unavailable();
    }

    private long activeForUser(UUID userId) {
        Long count = jdbc.queryForObject("""
            SELECT count(*)
              FROM assistant_turns t
              JOIN assistant_conversations c ON c.id=t.conversation_id
             WHERE c.user_id=? AND t.state='PROCESSING'
               AND t.claim_expires_at > clock_timestamp()
            """, Long.class, userId);
        return count == null ? 0L : count;
    }

    private long activeForMeeting(UUID meetingId) {
        Long count = jdbc.queryForObject("""
            SELECT count(*)
              FROM assistant_turns t
              JOIN assistant_conversations c ON c.id=t.conversation_id
             WHERE c.meeting_id=? AND t.state='PROCESSING'
               AND t.claim_expires_at > clock_timestamp()
            """, Long.class, meetingId);
        return count == null ? 0L : count;
    }

    private long activeGlobally() {
        Long count = jdbc.queryForObject("""
            SELECT count(*) FROM assistant_turns
             WHERE state='PROCESSING' AND claim_expires_at > clock_timestamp()
            """, Long.class);
        return count == null ? 0L : count;
    }

    private WindowUsage usage(UUID userId, String eventType, int windowSeconds) {
        return jdbc.query("""
            SELECT count(*) AS used,
                   min(occurred_at) AS oldest,
                   clock_timestamp() AS observed_at
              FROM assistant_admission_events
             WHERE user_id=? AND event_type=?
               AND occurred_at > clock_timestamp() - (? * interval '1 second')
            """, (rs, row) -> new WindowUsage(
                rs.getLong("used"),
                rs.getObject("oldest", OffsetDateTime.class),
                rs.getObject("observed_at", OffsetDateTime.class)),
            userId, eventType, windowSeconds).getFirst();
    }

    private int activeRetryAfter(String sql, Object... arguments) {
        LeaseBoundary boundary = jdbc.query(sql, (rs, row) -> new LeaseBoundary(
                rs.getObject("expires_at", OffsetDateTime.class),
                rs.getObject("observed_at", OffsetDateTime.class)), arguments)
            .getFirst();
        if (boundary.expiresAt() == null || boundary.observedAt() == null) {
            return CONCURRENCY_RETRY_AFTER_SECONDS;
        }
        return secondsUntil(boundary.observedAt(), boundary.expiresAt(),
            CONCURRENCY_RETRY_AFTER_SECONDS);
    }

    private static int quotaRetryAfter(WindowUsage usage, int windowSeconds) {
        if (usage.oldest() == null || usage.observedAt() == null) return windowSeconds;
        return secondsUntil(usage.observedAt(), usage.oldest().plusSeconds(windowSeconds),
            windowSeconds);
    }

    private static int secondsUntil(OffsetDateTime now, OffsetDateTime target, int fallback) {
        Duration remaining = Duration.between(now, target);
        if (remaining.isNegative() || remaining.isZero()) return 1;
        long nanos = remaining.toNanos();
        long seconds = (nanos + 999_999_999L) / 1_000_000_000L;
        return (int) Math.max(1L, Math.min(3_600L,
            seconds > Integer.MAX_VALUE ? fallback : seconds));
    }

    private void prune(UUID userId) {
        jdbc.update("""
            DELETE FROM assistant_admission_events
             WHERE user_id=?
               AND occurred_at <= clock_timestamp() - (? * interval '1 second')
            """, userId, retentionSeconds);
    }

    private void lock(String key) {
        jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended(?,0))",
            (ResultSet rs) -> {}, key);
    }

    private <T> T persist(Supplier<T> action) {
        try {
            return action.get();
        } catch (DataAccessException failure) {
            metrics.persistenceFailure();
            throw unavailable();
        }
    }

    private static void requireTransaction() {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("Assistant admission requires a database transaction");
        }
    }

    private void afterCommit(Runnable action) {
        if (!TransactionSynchronizationManager.isActualTransactionActive()
                || !TransactionSynchronizationManager.isSynchronizationActive()) {
            throw new IllegalStateException("Assistant admission telemetry requires a transaction");
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override public void afterCommit() {
                action.run();
            }
        });
    }

    private void reject(Reason reason, int retryAfter) {
        metrics.rejected(reason.name());
        throw new Rejected(reason, retryAfter);
    }

    private static ResponseStatusException unavailable() {
        return new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
            "Assistant admission is temporarily unavailable.");
    }

    enum Reason {
        ASK_QUOTA, CONVERSATION_QUOTA, USER_CONCURRENCY,
        MEETING_CONCURRENCY, GLOBAL_CONCURRENCY
    }

    static final class Rejected extends ResponseStatusException {
        private final HttpHeaders headers = new HttpHeaders();
        private final Reason reason;

        Rejected(Reason reason, int retryAfter) {
            super(HttpStatus.TOO_MANY_REQUESTS, "Assistant admission limit reached.");
            this.reason = reason;
            headers.set(HttpHeaders.RETRY_AFTER, Integer.toString(Math.max(1, retryAfter)));
            headers.setCacheControl("no-store");
        }

        Reason reason() {
            return reason;
        }

        @Override
        public HttpHeaders getHeaders() {
            return headers;
        }
    }

    private record WindowUsage(long used, OffsetDateTime oldest, OffsetDateTime observedAt) {}
    private record LeaseBoundary(OffsetDateTime expiresAt, OffsetDateTime observedAt) {}
}
