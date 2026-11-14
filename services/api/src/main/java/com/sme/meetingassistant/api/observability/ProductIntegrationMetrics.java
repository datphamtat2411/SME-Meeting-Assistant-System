package com.sme.meetingassistant.api.observability;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Component;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.TransactionException;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * PI-06: bounded, fixed-cardinality, database-derived operations metrics.
 * No user, meeting, worker, queue payload or content is exported as a label.
 * Failure never becomes a zero backlog: collection health is 0 and data is NaN.
 */
@Component
public final class ProductIntegrationMetrics {
    public static final Set<String> EXPORTED_NAMES = Set.of(
        "product.integration.outbox.pending",
        "product.integration.outbox.failed",
        "product.integration.outbox.oldest.age.seconds",
        "product.integration.processing.queued",
        "product.integration.processing.running",
        "product.integration.processing.failed",
        "product.integration.processing.oldest.age.seconds",
        "product.integration.assistant.expired.turns",
        "product.integration.assistant.failed.answers.window",
        "product.integration.knowledge.pending",
        "product.integration.knowledge.terminal",
        "product.integration.knowledge.oldest.age.seconds",
        "product.integration.knowledge.permits.reserved",
        "product.integration.knowledge.permits.running",
        "product.integration.knowledge.permits.failed",
        "product.integration.reconciliation.open.findings",
        "product.integration.reconciliation.failed.runs",
        "product.integration.reconciliation.incomplete.runs",
        "product.integration.reconciliation.certification.unusable",
        "product.integration.notification.pending",
        "product.integration.notification.failed",
        "product.integration.exports.pending",
        "product.integration.exports.generating",
        "product.integration.exports.failed",
        "product.integration.exports.oldest.age.seconds",
        "product.integration.metrics.aggregation.healthy"
    );

    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private volatile Map<String, Double> cached;
    private volatile long refreshedAt;
    private boolean attempted;

    public ProductIntegrationMetrics(JdbcTemplate jdbc, MeterRegistry registry) {
        this.jdbc = new JdbcTemplate(java.util.Objects.requireNonNull(jdbc.getDataSource()));
        this.jdbc.setQueryTimeout(5);
        this.transaction = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        transaction.setReadOnly(true);
        transaction.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        transaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);

        for (String name : EXPORTED_NAMES) {
            if (name.endsWith(".aggregation.healthy")) {
                Gauge.builder(name, this, m -> m.current() == null ? 0.0 : 1.0).register(registry);
            } else {
                Gauge.builder(name, this, m -> {
                    Map<String, Double> data = m.current();
                    return data == null ? Double.NaN : data.get(name);
                }).register(registry);
            }
        }
    }

    synchronized Map<String, Double> current() {
        long now = System.nanoTime();
        if (!attempted || now - refreshedAt >= 30_000_000_000L) {
            attempted = true;
            refreshedAt = now;
            try {
                cached = transaction.execute(tx -> readSnapshot());
            } catch (DataAccessException | TransactionException | IllegalStateException failure) {
                cached = null;
            }
        }
        return cached;
    }

    /** Visible to integration tests; executes one repeatable-read operational snapshot. */
    Map<String, Double> readSnapshot() {
        Map<String, Double> out = new HashMap<>();
        Map<String, Object> box = jdbc.queryForMap("""
            SELECT count(*) FILTER (WHERE status='PENDING') AS pending,
                   count(*) FILTER (WHERE status='FAILED') AS failed,
                   coalesce(max(greatest(0,extract(epoch from
                       transaction_timestamp()-occurred_at)))
                       FILTER (WHERE status='PENDING'),0) AS age
            FROM outbox_events
            """);
        put(out, "outbox.pending", box, "pending");
        put(out, "outbox.failed", box, "failed");
        put(out, "outbox.oldest.age.seconds", box, "age");

        Map<String, Object> jobs = jdbc.queryForMap("""
            SELECT count(*) FILTER (WHERE status='QUEUED') AS queued,
                   count(*) FILTER (WHERE status='RUNNING') AS running,
                   count(*) FILTER (WHERE status='FAILED') AS failed,
                   coalesce(max(greatest(0,extract(epoch from
                       transaction_timestamp()-queued_at)))
                       FILTER (WHERE status IN ('QUEUED','RUNNING')),0) AS age
            FROM processing_jobs
            """);
        put(out, "processing.queued", jobs, "queued");
        put(out, "processing.running", jobs, "running");
        put(out, "processing.failed", jobs, "failed");
        put(out, "processing.oldest.age.seconds", jobs, "age");

        Map<String, Object> turns = jdbc.queryForMap("""
            SELECT count(*) AS expired FROM assistant_turns
            WHERE state='PROCESSING' AND claim_expires_at < transaction_timestamp()
            """);
        put(out, "assistant.expired.turns", turns, "expired");
        Map<String, Object> answers = jdbc.queryForMap("""
            SELECT count(*) AS failed FROM assistant_messages
            WHERE role='ASSISTANT' AND answer_status='FAILED'
              AND created_at >= transaction_timestamp()-interval '24 hours'
            """);
        put(out, "assistant.failed.answers.window", answers, "failed");

        Map<String, Object> knowledge = jdbc.queryForMap("""
            SELECT count(*) FILTER (WHERE state IN ('PENDING','RETRYABLE_FAILURE')) AS pending,
                   count(*) FILTER (WHERE state='TERMINAL_FAILURE') AS terminal,
                   coalesce(max(greatest(0,extract(epoch from
                       transaction_timestamp()-created_at)))
                       FILTER (WHERE state IN ('PENDING','RETRYABLE_FAILURE')),0) AS age
            FROM knowledge_indexing_work
            """);
        put(out, "knowledge.pending", knowledge, "pending");
        put(out, "knowledge.terminal", knowledge, "terminal");
        put(out, "knowledge.oldest.age.seconds", knowledge, "age");
        Map<String, Object> permits = jdbc.queryForMap("""
            SELECT count(*) FILTER (WHERE state='RESERVED') AS reserved,
                   count(*) FILTER (WHERE state='RUNNING') AS running,
                   count(*) FILTER (WHERE state='FAILED') AS failed
              FROM knowledge_qdrant_write_permits
            """);
        put(out, "knowledge.permits.reserved", permits, "reserved");
        put(out, "knowledge.permits.running", permits, "running");
        put(out, "knowledge.permits.failed", permits, "failed");
        put(out, "reconciliation.open.findings", jdbc.queryForMap("""
            SELECT count(*) AS amount FROM knowledge_reconciliation_findings
            WHERE state IN ('OPEN','MANUAL_REVIEW')
            """), "amount");
        Map<String, Object> runs = jdbc.queryForMap("""
            SELECT count(*) FILTER (WHERE state='FAILED') AS failed,
                   count(*) FILTER (WHERE state='COMPLETED' AND NOT inventory_complete) AS incomplete
            FROM knowledge_reconciliation_runs
            """);
        put(out, "reconciliation.failed.runs", runs, "failed");
        put(out, "reconciliation.incomplete.runs", runs, "incomplete");
        Map<String, Object> certification = jdbc.queryForMap("""
            SELECT count(*) AS unusable
              FROM knowledge_index_generations g
             WHERE g.state='READY'
               AND NOT EXISTS (
                   SELECT 1 FROM knowledge_reconciliation_runs r
                    WHERE r.generation_id=g.generation_id
                      AND r.certification_mode='CERTIFICATION'
                      AND r.certification_seal_id=g.seal_id
                      AND r.certification_epoch=g.write_epoch
                      AND r.state='COMPLETED' AND r.dry_run
                      AND r.inventory_complete AND r.finding_count=0 AND r.repaired_count=0
               )
            """);
        put(out, "reconciliation.certification.unusable", certification, "unusable");

        Map<String, Object> mail = jdbc.queryForMap("""
            SELECT count(*) FILTER (WHERE status='PENDING') AS pending,
                   count(*) FILTER (WHERE status='FAILED') AS failed
            FROM email_deliveries
            """);
        put(out, "notification.pending", mail, "pending");
        put(out, "notification.failed", mail, "failed");

        Map<String, Object> exports = jdbc.queryForMap("""
            SELECT count(*) FILTER (WHERE status='PENDING') AS pending,
                   count(*) FILTER (WHERE status='GENERATING') AS generating,
                   count(*) FILTER (WHERE status='FAILED') AS failed,
                   coalesce(max(greatest(0,extract(epoch from
                       transaction_timestamp()-created_at)))
                       FILTER (WHERE status IN ('PENDING','GENERATING')),0) AS age
            FROM meeting_exports
            """);
        put(out, "exports.pending", exports, "pending");
        put(out, "exports.generating", exports, "generating");
        put(out, "exports.failed", exports, "failed");
        put(out, "exports.oldest.age.seconds", exports, "age");
        if (out.size() != EXPORTED_NAMES.size()-1) {
            throw new IllegalStateException("Incomplete operational measurement registry");
        }
        return Map.copyOf(out);
    }

    private static void put(Map<String, Double> result, String suffix,
            Map<String, Object> row, String field) {
        Object value = row.get(field);
        if (!(value instanceof Number number) || !Double.isFinite(number.doubleValue())
                || number.doubleValue() < 0) {
            throw new IllegalStateException("Invalid operational metric result");
        }
        result.put("product.integration."+suffix,number.doubleValue());
    }
}
