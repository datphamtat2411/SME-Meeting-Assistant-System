package com.sme.meetingassistant.api.authentication.recovery;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Bounded retention for setup/reset authorizations only. Never deletes users,
 * security audit events, email delivery history, sessions or refresh tokens.
 * Transactional batches with SKIP LOCKED are safe across API instances.
 */
@Component
@ConditionalOnProperty(prefix = "app.auth.token-retention", name = "enabled",
                       havingValue = "true")
public final class AuthTokenRetentionCleanup {
    private static final Logger log = LoggerFactory.getLogger(AuthTokenRetentionCleanup.class);
    private static final int BATCH_SIZE = 200;
    private static final int MAX_BATCHES_PER_RUN = 10;
    private final NamedParameterJdbcTemplate jdbc;
    private final TransactionTemplate transactions;

    public AuthTokenRetentionCleanup(JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager) {
        this.jdbc = new NamedParameterJdbcTemplate(jdbc);
        this.transactions = new TransactionTemplate(transactionManager);
    }

    @Scheduled(
        initialDelayString = "${app.auth.token-retention.initial-delay-ms:3600000}",
        fixedDelayString = "${app.auth.token-retention.poll-delay-ms:3600000}")
    public void poll() {
        int setup = 0;
        int recovery = 0;
        for (int i = 0; i < MAX_BATCHES_PER_RUN; i++) {
            PurgeCounts batch = cleanupBatch();
            setup += batch.setup();
            recovery += batch.recovery();
            if (batch.setup() < BATCH_SIZE && batch.recovery() < BATCH_SIZE) break;
        }
        if (setup != 0 || recovery != 0) {
            // Counts only; no user addresses, token IDs, verifiers or raw bearers.
            log.info("Auth technical retention cleanup: setup={}, recovery={}", setup, recovery);
        }
    }

    /** One independently atomic, bounded pass; callable by PostgreSQL integration tests. */
    public PurgeCounts cleanupBatch() {
        PurgeCounts result = transactions.execute(status -> {
            OffsetDateTime cutoff = OffsetDateTime.now(ZoneOffset.UTC).minusDays(30);
            int setup = purgeSetup(cutoff);
            int recovery = purgeRecovery(cutoff);
            return new PurgeCounts(setup, recovery);
        });
        if (result == null) throw new IllegalStateException("Token retention transaction did not execute");
        return result;
    }

    private int purgeSetup(OffsetDateTime cutoff) {
        List<UUID> ids = jdbc.query("""
            SELECT id FROM account_setup_tokens
             WHERE expires_at < :cutoff OR used_at < :cutoff OR revoked_at < :cutoff
             ORDER BY expires_at, id LIMIT :batchSize FOR UPDATE SKIP LOCKED
            """, Map.of("cutoff", cutoff, "batchSize", BATCH_SIZE),
            (rs, row) -> rs.getObject(1, UUID.class));
        if (ids.isEmpty()) return 0;
        retireDeliveries(ids, "ACCOUNT_SETUP", "ACCOUNT_SETUP");
        return jdbc.update("DELETE FROM account_setup_tokens WHERE id IN (:ids)",
            Map.of("ids", ids));
    }

    private int purgeRecovery(OffsetDateTime cutoff) {
        List<UUID> ids = jdbc.query("""
            SELECT id FROM password_reset_tokens
             WHERE expires_at < :cutoff OR used_at < :cutoff OR revoked_at < :cutoff
             ORDER BY expires_at, id LIMIT :batchSize FOR UPDATE SKIP LOCKED
            """, Map.of("cutoff", cutoff, "batchSize", BATCH_SIZE),
            (rs, row) -> rs.getObject(1, UUID.class));
        if (ids.isEmpty()) return 0;
        retireDeliveries(ids, "PASSWORD_RECOVERY", "PASSWORD_RESET");
        return jdbc.update("DELETE FROM password_reset_tokens WHERE id IN (:ids)",
            Map.of("ids", ids));
    }

    private void retireDeliveries(List<UUID> ids, String notificationType, String entityType) {
        // At 30+ days beyond token invalidation there is no usable capability.
        // Retain delivery metadata, but never leave an obsolete queued/retrying
        // email intent runnable after its token verifier is purged.
        jdbc.update("""
            UPDATE email_deliveries SET status='DEAD',
                last_error_code='TOKEN_RETENTION_PURGED',
                last_error_summary=NULL,next_attempt_at=NULL,
                updated_at=clock_timestamp()
             WHERE notification_type=:notificationType
               AND related_entity_type=:entityType
               AND related_entity_id IN (:ids)
               AND status IN ('PENDING','FAILED','SENDING')
            """, Map.of("ids", ids, "notificationType", notificationType,
                "entityType", entityType));
    }

    public record PurgeCounts(int setup, int recovery) {}
}
