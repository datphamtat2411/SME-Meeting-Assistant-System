package com.sme.meetingassistant.api.meetingexport;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import java.time.Duration;
import java.util.Objects;
import java.util.concurrent.TimeUnit;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * DE-12 operational measurements. Tags are finite status/format/outcome codes,
 * never IDs, object names, source contents, exception messages or signed URLs.
 */
@Component
public final class ExportOperationalMetrics {
    private final MeterRegistry registry;
    private final JdbcTemplate jdbc;

    public ExportOperationalMetrics(MeterRegistry registry, JdbcTemplate jdbc) {
        this.registry = Objects.requireNonNull(registry);
        this.jdbc = Objects.requireNonNull(jdbc);
        for (String state : new String[]{"PENDING", "GENERATING", "FAILED"}) {
            Gauge.builder("sme.exports.jobs", () -> countState(state))
                    .description("Durable export jobs by bounded lifecycle state")
                    .tag("state", state)
                    .strongReference(true)
                    .register(registry);
        }
    }

    private double countState(String state) {
        try {
            Long n = jdbc.queryForObject(
                    "SELECT count(*) FROM meeting_exports WHERE status = ?",
                    Long.class, state);
            return n == null ? Double.NaN : n.doubleValue();
        } catch (RuntimeException unavailable) {
            // Metrics must not block the API or hide DB outages as zero backlog.
            return Double.NaN;
        }
    }

    public void execution(ExportFormat format, String outcome, long elapsedNanos) {
        String result = switch (outcome) {
            case "READY", "FENCED", "STORAGE_INTEGRITY", "STORAGE_UNAVAILABLE",
                    "SOURCE_INVALID", "RENDER_FAILED" -> outcome;
            default -> "RENDER_FAILED";
        };
        Timer.builder("sme.exports.generation.duration")
                .description("Duration of one fenced export attempt")
                .tags("format", format == ExportFormat.PDF ? "PDF" : "MARKDOWN",
                        "outcome", result)
                .publishPercentileHistogram()
                .minimumExpectedValue(Duration.ofMillis(1))
                .maximumExpectedValue(Duration.ofMinutes(15))
                .register(registry).record(Math.max(0, elapsedNanos), TimeUnit.NANOSECONDS);
    }

    public void retried() {
        Counter.builder("sme.exports.retries").register(registry).increment();
    }

    public void expiredClaims(int count) {
        if (count > 0) Counter.builder("sme.exports.expired.claims")
                .register(registry).increment(count);
    }

    public void reconciliation(int listed, int observed, int purged) {
        increment("sme.exports.inventory.objects", listed);
        increment("sme.exports.orphans.observed", observed);
        increment("sme.exports.orphans.purged", purged);
    }

    public void reconciliationFailure() {
        Counter.builder("sme.exports.reconciliation.failures")
                .register(registry).increment();
    }

    public void idempotencyCleanup(int count) {
        increment("sme.exports.idempotency.receipts.cleaned", count);
    }

    public void idempotencyCleanupFailure() {
        Counter.builder("sme.exports.idempotency.cleanup.failures")
                .register(registry).increment();
    }

    private void increment(String name, int count) {
        if (count > 0) Counter.builder(name).register(registry).increment(count);
    }
}
