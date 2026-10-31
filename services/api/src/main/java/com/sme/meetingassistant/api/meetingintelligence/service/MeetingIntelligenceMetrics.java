package com.sme.meetingassistant.api.meetingintelligence.service;

import io.micrometer.core.instrument.MeterRegistry;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import org.springframework.http.HttpStatusCode;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.server.ResponseStatusException;

/** Fixed-cardinality MI telemetry: commit-only success and outer-boundary failures. */
@Component
public class MeetingIntelligenceMetrics {
    private static final Set<String> OPERATIONS = Set.of("ai_result_ingestion", "summary_regeneration");
    private static final Set<String> OUTCOMES =
        Set.of("ACCEPTED", "REPLAY", "REJECTED", "CONFLICT", "UNAVAILABLE", "ERROR");
    private final MeterRegistry registry;
    public MeetingIntelligenceMetrics(MeterRegistry registry) { this.registry = registry; }

    public void committed(String operation, String outcome) {
        if (!TransactionSynchronizationManager.isActualTransactionActive()
                || !TransactionSynchronizationManager.isSynchronizationActive()) {
            throw new IllegalStateException("MI success telemetry requires a transaction.");
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override public void afterCommit() { increment(operation, outcome); }
        });
    }

    public void failure(String operation, RuntimeException exception) {
        String outcome = "ERROR";
        if (exception instanceof ResponseStatusException response) {
            HttpStatusCode code = response.getStatusCode();
            if (code.value() == 503) outcome = "UNAVAILABLE";
            else if (code.value() == 409 || code.value() == 412) outcome = "CONFLICT";
            else if (code.is4xxClientError()) outcome = "REJECTED";
        } else if (exception instanceof IllegalArgumentException) {
            outcome = "REJECTED";
        }
        increment(operation, outcome);
    }

    public void duration(String operation, long elapsedNanos) {
        requireOperation(operation);
        registry.timer("meeting.intelligence.duration", "operation", operation)
            .record(Math.max(0L, elapsedNanos), TimeUnit.NANOSECONDS);
    }

    private static void requireOperation(String operation) {
        if (!OPERATIONS.contains(operation)) throw new IllegalArgumentException("Unknown MI operation.");
    }

    private void increment(String operation, String outcome) {
        requireOperation(operation);
        if (!OUTCOMES.contains(outcome)) throw new IllegalArgumentException("Unknown MI outcome.");
        // No IDs, exception messages or sensitive content as metric labels.
        registry.counter("meeting.intelligence.operations",
            "operation", operation, "outcome", outcome).increment();
    }
}
