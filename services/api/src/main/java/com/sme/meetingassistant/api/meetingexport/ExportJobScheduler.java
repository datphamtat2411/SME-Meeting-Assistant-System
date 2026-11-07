package com.sme.meetingassistant.api.meetingexport;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Explicitly opt-in. Multiple instances may safely poll one PostgreSQL queue;
 * production admission is gated separately until Product/Security D09 review.
 */
@Component
@ConditionalOnProperty(name="app.exports.worker.enabled", havingValue="true")
public class ExportJobScheduler {
    private final ExportJobProcessor processor;

    public ExportJobScheduler(ExportJobProcessor processor) {
        this.processor = processor;
    }

    @Scheduled(fixedDelayString="${app.exports.worker.poll-delay-ms:2000}",
            scheduler="exportWorkerScheduler")
    public void runOnce() {
        processor.reconcile();
        for (int i = 0; i < 4; i++) {
            if (!processor.processNext()) return;
        }
    }
}
