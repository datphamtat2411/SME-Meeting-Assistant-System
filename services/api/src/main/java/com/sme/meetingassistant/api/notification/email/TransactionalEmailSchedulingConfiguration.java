package com.sme.meetingassistant.api.notification.email;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/** One switch controls polling for every transactional email purpose. */
@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "app.email.delivery", name = "worker-enabled",
                       havingValue = "true", matchIfMissing = true)
@EnableScheduling
public class TransactionalEmailSchedulingConfiguration { }
