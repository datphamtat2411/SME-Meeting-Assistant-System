package com.sme.meetingassistant.api.meetingexport;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Non-destructive inventory opt-in; purge has independent approval gate. */
@Component
@ConditionalOnProperty(name="app.exports.reconciliation.enabled", havingValue="true")
public final class ExportReconciliationScheduler {
    private final ExportOrphanReconciler reconciler;
    private final ExportOperationalMetrics metrics;

    public ExportReconciliationScheduler(ExportOrphanReconciler reconciler, ExportOperationalMetrics metrics) {
        this.reconciler = reconciler;
        this.metrics = metrics;
    }

    @Scheduled(fixedDelayString="${app.exports.reconciliation.poll-delay-ms:900000}")
    public void scan() {
        try {
            var result = reconciler.runOnce();
            metrics.reconciliation(result.listed(), result.orphanObserved(), result.deleted());
        } catch (RuntimeException failure) {
            metrics.reconciliationFailure();
            org.slf4j.LoggerFactory.getLogger(getClass()).warn(
                    "Export inventory iteration failed ({})", failure.getClass().getSimpleName());
        }
    }
}
