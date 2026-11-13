package com.sme.meetingassistant.api.assistant;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Fixed-cardinality Assistant admission telemetry without sensitive labels. */
@Component
public final class AssistantAdmissionMetrics {
    public static final Set<String> EXPORTED_NAMES = Set.of(
        "sme.assistant.admission.active",
        "sme.assistant.admission.accepted",
        "sme.assistant.admission.replayed",
        "sme.assistant.admission.rejected",
        "sme.assistant.admission.persistence.failures",
        "sme.assistant.admission.latency",
        "sme.assistant.leases.expired",
        "sme.assistant.leases.reclaimed");
    private static final Set<String> OPERATIONS = Set.of("ASK", "CONVERSATION_CREATE");
    private static final Set<String> REASONS = Set.of(
        "ASK_QUOTA", "CONVERSATION_QUOTA", "USER_CONCURRENCY",
        "MEETING_CONCURRENCY", "GLOBAL_CONCURRENCY");

    private final MeterRegistry registry;
    private final JdbcTemplate jdbc;

    AssistantAdmissionMetrics(MeterRegistry registry, JdbcTemplate jdbc) {
        this.registry = registry;
        this.jdbc = jdbc;
        Gauge.builder("sme.assistant.admission.active", this,
                AssistantAdmissionMetrics::activeTurns)
            .description("Durable Assistant turns with a live processing lease")
            .register(registry);
    }

    void accepted(String operation) {
        requireOperation(operation);
        registry.counter("sme.assistant.admission.accepted", "operation", operation).increment();
    }

    void replayed() {
        registry.counter("sme.assistant.admission.replayed").increment();
    }

    void rejected(String reason) {
        if (!REASONS.contains(reason)) throw new IllegalArgumentException("Unknown admission reason");
        registry.counter("sme.assistant.admission.rejected", "reason", reason).increment();
    }

    void persistenceFailure() {
        registry.counter("sme.assistant.admission.persistence.failures").increment();
    }

    void leaseExpired() {
        registry.counter("sme.assistant.leases.expired").increment();
    }

    void leaseReclaimed() {
        registry.counter("sme.assistant.leases.reclaimed").increment();
    }

    void latency(String operation, long elapsedNanos) {
        requireOperation(operation);
        Timer.builder("sme.assistant.admission.latency")
            .tag("operation", operation)
            .description("PostgreSQL Assistant admission transaction latency")
            .register(registry)
            .record(Math.max(0L, elapsedNanos), TimeUnit.NANOSECONDS);
    }

    private double activeTurns() {
        try {
            Long count = jdbc.queryForObject("""
                SELECT count(*) FROM assistant_turns
                 WHERE state='PROCESSING' AND claim_expires_at > clock_timestamp()
                """, Long.class);
            return count == null ? Double.NaN : count.doubleValue();
        } catch (RuntimeException unavailable) {
            return Double.NaN;
        }
    }

    private static void requireOperation(String operation) {
        if (!OPERATIONS.contains(operation)) throw new IllegalArgumentException("Unknown admission operation");
    }
}
