package com.sme.meetingassistant.api.media.service;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Keeps the lease-recovery trigger independently controllable from the
 * lifecycle boundary. Database integration fixtures can disable the
 * asynchronous trigger while still exercising the recovery operation directly.
 */
@Component
@ConditionalOnProperty(prefix = "app.media.processing", name = "stage-lease-sweep-enabled",
        havingValue = "true", matchIfMissing = true)
final class ProcessingJobLeaseSweepScheduler {
    private final ProcessingJobLifecycleService lifecycle;

    ProcessingJobLeaseSweepScheduler(ProcessingJobLifecycleService lifecycle) {
        this.lifecycle = lifecycle;
    }

    @Scheduled(fixedDelayString = "${app.media.processing.stage-lease-sweep-ms:60000}")
    void sweep() {
        lifecycle.expireAbandonedStages();
    }
}
