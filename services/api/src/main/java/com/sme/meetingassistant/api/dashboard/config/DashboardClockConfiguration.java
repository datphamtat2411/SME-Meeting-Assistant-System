package com.sme.meetingassistant.api.dashboard.config;

import java.time.Clock;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Injectable server clock for deterministic dashboard time-boundary tests. */
@Configuration(proxyBeanMethods = false)
public class DashboardClockConfiguration {
    @Bean
    Clock dashboardClock() {
        return Clock.systemUTC();
    }
}
