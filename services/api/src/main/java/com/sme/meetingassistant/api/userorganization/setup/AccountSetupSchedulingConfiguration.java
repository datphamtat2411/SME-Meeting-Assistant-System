package com.sme.meetingassistant.api.userorganization.setup;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/** Disable via APP_ACCOUNT_SETUP_WORKER_ENABLED=false in integration tests and operational maintenance. */
@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "app.account-setup", name = "worker-enabled",
                       havingValue = "true", matchIfMissing = true)
@EnableScheduling
public class AccountSetupSchedulingConfiguration {}
