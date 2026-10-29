package com.sme.meetingassistant.api.authentication.recovery;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Explicit opt-in: retention runs even when the shared SMTP worker is disabled.
 * Reuses Spring's scheduler, without a second queue or external dependency.
 */
@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "app.auth.token-retention", name = "enabled",
                       havingValue = "true")
@EnableScheduling
public class AuthTokenRetentionSchedulingConfiguration {}
