package com.sme.meetingassistant.api.knowledge;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Fixed-cardinality knowledge fencing and reconciliation measurements. */
@Component
public final class KnowledgeOperationalMetrics {
    public static final Set<String> EXPORTED_NAMES = Set.of(
        "product.integration.knowledge.seal.attempts",
        "product.integration.knowledge.seal.successes",
        "product.integration.knowledge.seal.rejections",
        "product.integration.knowledge.seal.releases",
        "product.integration.knowledge.permit.reservation.conflicts",
        "product.integration.knowledge.permit.start.conflicts",
        "product.integration.knowledge.permit.completion.conflicts",
        "product.integration.reconciliation.claim.expirations",
        "product.integration.reconciliation.stale.result.rejections",
        "product.integration.reconciliation.epoch.mismatch.rejections",
        "product.integration.reconciliation.remote.audit.latency.seconds",
        "product.integration.reconciliation.transaction.duration.seconds",
        "product.integration.knowledge.activation.rejections");

    static final Set<String> SEAL_REJECTION_REASONS = Set.of(
        "GENERATION_NOT_READY", "WORKER_CLAIM_ACTIVE", "QDRANT_PERMIT_OPEN",
        "INDEXING_WORK_UNRESOLVED");
    static final Set<String> SEAL_RELEASE_REASONS = Set.of("MUTATION", "UNSEALED", "ACTIVATED");
    static final Set<String> AUDIT_PHASES = Set.of("SOURCE_COUNTS", "VECTOR_INVENTORY");
    static final Set<String> ACTIVATION_REASONS = Set.of(
        "NOT_READY", "SEAL_REQUIRED", "CERTIFICATION_REQUIRED", "PERMIT_OPEN",
        "RUNTIME_MISMATCH", "ACTIVE_GENERATION_UNSEALABLE");

    private final JdbcTemplate jdbc;
    private final Map<String, AtomicReference<Double>> values = new HashMap<>();
    private final Map<String, Map<String, AtomicReference<Double>>> taggedValues = new HashMap<>();

    public KnowledgeOperationalMetrics(JdbcTemplate jdbc, MeterRegistry registry) {
        this.jdbc = new JdbcTemplate(java.util.Objects.requireNonNull(jdbc.getDataSource()));
        this.jdbc.setQueryTimeout(5);
        registerValue(registry, "product.integration.knowledge.seal.attempts");
        registerValue(registry, "product.integration.knowledge.seal.successes");
        registerTagged(registry, "product.integration.knowledge.seal.rejections", "reason",
            SEAL_REJECTION_REASONS);
        registerTaggedGauge(registry, "product.integration.knowledge.seal.releases", "reason",
            SEAL_RELEASE_REASONS);
        registerValue(registry, "product.integration.knowledge.permit.reservation.conflicts");
        registerValue(registry, "product.integration.knowledge.permit.start.conflicts");
        registerValue(registry, "product.integration.knowledge.permit.completion.conflicts");
        registerValue(registry, "product.integration.reconciliation.claim.expirations");
        registerValue(registry, "product.integration.reconciliation.stale.result.rejections");
        registerValue(registry, "product.integration.reconciliation.epoch.mismatch.rejections");
        registerTagged(registry, "product.integration.reconciliation.remote.audit.latency.seconds", "phase",
            AUDIT_PHASES);
        registerValue(registry, "product.integration.reconciliation.transaction.duration.seconds");
        registerTagged(registry, "product.integration.knowledge.activation.rejections", "reason",
            ACTIVATION_REASONS);
    }

    void sealAttempt() { increment("product.integration.knowledge.seal.attempts"); }
    void sealSuccess() { increment("product.integration.knowledge.seal.successes"); }
    void sealRejected(String reason) { incrementTagged(
        "product.integration.knowledge.seal.rejections", SEAL_REJECTION_REASONS, reason); }
    void permitReservationConflict() { increment("product.integration.knowledge.permit.reservation.conflicts"); }
    void permitStartConflict() { increment("product.integration.knowledge.permit.start.conflicts"); }
    void permitCompletionConflict() { increment("product.integration.knowledge.permit.completion.conflicts"); }
    void reconciliationClaimExpired() { increment("product.integration.reconciliation.claim.expirations"); }
    void reconciliationStaleResult() { increment("product.integration.reconciliation.stale.result.rejections"); }
    void reconciliationEpochMismatch() { increment("product.integration.reconciliation.epoch.mismatch.rejections"); }
    void activationRejected(String reason) { incrementTagged(
        "product.integration.knowledge.activation.rejections", ACTIVATION_REASONS, reason); }

    void remoteAuditLatency(String phase, long nanos) {
        setTagged("product.integration.reconciliation.remote.audit.latency.seconds", AUDIT_PHASES,
            phase, Math.max(0L, nanos) / 1_000_000_000d);
    }

    void reconciliationTransactionDuration(long nanos) {
        values.get("product.integration.reconciliation.transaction.duration.seconds")
            .set(Math.max(0L, nanos) / 1_000_000_000d);
    }

    private void registerValue(MeterRegistry registry, String name) {
        AtomicReference<Double> value = new AtomicReference<>(0d);
        values.put(name, value);
        Gauge.builder(name, value, measurement -> measurement.get()).register(registry);
    }

    private void registerTagged(MeterRegistry registry, String name, String tag, Set<String> allowed) {
        Map<String, AtomicReference<Double>> family = new HashMap<>();
        taggedValues.put(name, family);
        for (String value : allowed) {
            AtomicReference<Double> measurement = new AtomicReference<>(0d);
            family.put(value, measurement);
            Gauge.builder(name, measurement, current -> current.get()).tag(tag, value).register(registry);
        }
    }

    private void registerTaggedGauge(MeterRegistry registry, String name, String tag, Set<String> allowed) {
        for (String value : allowed) {
            Gauge.builder(name, this, metrics -> metrics.releaseCount(value))
                .tag(tag, value).register(registry);
        }
    }

    private void increment(String name) {
        values.get(name).updateAndGet(value -> value + 1d);
    }

    private void incrementTagged(String name, Set<String> allowed, String value) {
        requireAllowed(allowed, value);
        taggedValues.get(name).get(value).updateAndGet(measurement -> measurement + 1d);
    }

    private void setTagged(String name, Set<String> allowed, String value, double measurement) {
        requireAllowed(allowed, value);
        taggedValues.get(name).get(value).set(measurement);
    }

    private double releaseCount(String reason) {
        try {
            Number count = jdbc.queryForObject(
                "SELECT count(*) FROM knowledge_generation_seals WHERE release_reason=?",
                Number.class, reason);
            return count == null ? Double.NaN : count.doubleValue();
        } catch (RuntimeException unavailable) {
            return Double.NaN;
        }
    }

    private static void requireAllowed(Set<String> allowed, String value) {
        if (!allowed.contains(value)) throw new IllegalArgumentException("Unknown bounded metric category");
    }
}
