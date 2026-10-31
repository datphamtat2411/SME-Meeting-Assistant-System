package com.sme.meetingassistant.api.meetingintelligence.service;

import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.http.HttpStatusCode;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.server.ResponseStatusException;

/** Fixed-cardinality MI telemetry: commit-only success and outer-boundary failures. */
@Component
public class MeetingIntelligenceMetrics {
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

    private void increment(String operation, String outcome) {
        // Caller passes only fixed action names; no IDs, exception messages or content as labels.
        registry.counter("meeting.intelligence.operations",
            "operation", operation, "outcome", outcome).increment();
    }
}
