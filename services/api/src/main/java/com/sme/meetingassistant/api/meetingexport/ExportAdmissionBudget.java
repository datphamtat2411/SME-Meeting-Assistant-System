package com.sme.meetingassistant.api.meetingexport;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * DE-12: durable cross-node admission backpressure. Source replay is already
 * checked in ExportSubmissionService, so this gate only checks NEW intents.
 * Must run in the same transaction as the pending intent and intake receipt.
 */
@Service
public class ExportAdmissionBudget {
    private static final long LOCK_KEY = 871296420123L;
    private final JdbcTemplate jdbc;
    private final MeterRegistry metrics;
    private final int maxActorActive;
    private final int maxGlobalActive;

    public ExportAdmissionBudget(JdbcTemplate jdbc, MeterRegistry metrics,
            @Value("${app.exports.admission.max-active-per-user:5}") int maxActorActive,
            @Value("${app.exports.admission.max-active-global:500}") int maxGlobalActive) {
        if (maxActorActive < 1 || maxActorActive > 100
                || maxGlobalActive < maxActorActive || maxGlobalActive > 100_000) {
            throw new IllegalArgumentException("Unsafe export backlog admission limits");
        }
        this.jdbc = jdbc;
        this.metrics = metrics;
        this.maxActorActive = maxActorActive;
        this.maxGlobalActive = maxGlobalActive;
    }

    @Transactional(propagation=Propagation.MANDATORY)
    public void verifyNewIntent(UUID actor) {
        // PG transaction-scoped lock serializes checks across all API nodes.
        // The new PENDING row was inserted earlier in this SAME transaction.
        jdbc.execute("SELECT pg_advisory_xact_lock(" + LOCK_KEY + ")");
        Long perActor = jdbc.queryForObject("""
            SELECT count(*) FROM meeting_exports WHERE requested_by_user_id=?
              AND status IN ('PENDING','GENERATING')
            """,Long.class,actor);
        Long global = jdbc.queryForObject("""
            SELECT count(*) FROM meeting_exports
             WHERE status IN ('PENDING','GENERATING')
            """,Long.class);
        if (perActor == null || global == null
                || perActor > maxActorActive || global > maxGlobalActive) {
            Counter.builder("sme.exports.admission.throttled").register(metrics).increment();
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                    "Export backlog limit reached; retry after active jobs complete");
        }
    }
}
