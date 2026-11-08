package com.sme.meetingassistant.api.meetingexport;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

@Configuration(proxyBeanMethods=false)
@ConditionalOnProperty(name="app.exports.worker.enabled", havingValue="true")
public class ExportSchedulerConfiguration {
    @Bean("exportWorkerScheduler")
    public ThreadPoolTaskScheduler exportWorkerScheduler() {
        ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
        scheduler.setPoolSize(1);
        scheduler.setThreadNamePrefix("export-job-poll-");
        scheduler.setRemoveOnCancelPolicy(true);
        return scheduler;
    }
}
