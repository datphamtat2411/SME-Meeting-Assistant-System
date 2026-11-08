package com.sme.meetingassistant.api.meetingexport;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Non-destructive inventory opt-in; purge has independent approval gate. */
@Component
@ConditionalOnProperty(name="app.exports.reconciliation.enabled", havingValue="true")
public final class ExportReconciliationScheduler {
    private final ExportOrphanReconciler reconciler;

    public ExportReconciliationScheduler(ExportOrphanReconciler reconciler) {
        this.reconciler = reconciler;
    }

    @Scheduled(fixedDelayString="${app.exports.reconciliation.poll-delay-ms:900000}")
    public void scan() {
        reconciler.runOnce();
    }
}
