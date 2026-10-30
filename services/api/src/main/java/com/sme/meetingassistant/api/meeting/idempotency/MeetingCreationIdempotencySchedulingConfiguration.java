package com.sme.meetingassistant.api.meeting.idempotency;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Keep meeting-create idempotency housekeeping independent of optional SMTP
 * delivery and auth-token cleanup. Default-on; may be disabled explicitly for
 * controlled deployments where an external cleanup process owns retention.
 */
@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "app.meeting.idempotency", name = "cleanup-enabled",
        havingValue = "true", matchIfMissing = true)
@EnableScheduling
public class MeetingCreationIdempotencySchedulingConfiguration {
    private final MeetingCreationIdempotencyService service;

    public MeetingCreationIdempotencySchedulingConfiguration(
            MeetingCreationIdempotencyService service) {
        this.service = service;
    }

    @Scheduled(fixedDelayString = "${app.meeting.idempotency.cleanup-delay-ms:3600000}")
    public void cleanup() {
        service.removeExpired();
    }
}
