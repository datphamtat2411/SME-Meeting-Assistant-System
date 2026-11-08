package com.sme.meetingassistant.api.meetingexport;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;

/**
 * Receipt housekeeping is independent of public Export admission and worker
 * switches. It is default-on because it only removes expired receipts.
 */
@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "app.exports.idempotency-cleanup", name = "enabled",
        havingValue = "true", matchIfMissing = true)
@EnableScheduling
public class ExportIdempotencyRetentionSchedulingConfiguration {
    private final ExportIdempotencyRetentionCleanup cleanup;

    public ExportIdempotencyRetentionSchedulingConfiguration(
            ExportIdempotencyRetentionCleanup cleanup) {
        this.cleanup = cleanup;
    }

    @Scheduled(
        initialDelayString = "${app.exports.idempotency-cleanup.initial-delay-ms:3600000}",
        fixedDelayString = "${app.exports.idempotency-cleanup.poll-delay-ms:3600000}")
    public void cleanup() {
        cleanup.poll();
    }
}
