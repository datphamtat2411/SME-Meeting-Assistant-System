package com.sme.meetingassistant.api.media.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.ScheduledFuture;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.ScheduledAnnotationBeanPostProcessor;

class ProcessingJobLeaseSweepSchedulerTests {
    private final ProcessingJobLifecycleService lifecycle = mock(ProcessingJobLifecycleService.class);
    private final TaskScheduler scheduler = mock(TaskScheduler.class);
    private final ApplicationContextRunner contexts = new ApplicationContextRunner()
        .withUserConfiguration(Scheduling.class, ProcessingJobLeaseSweepScheduler.class)
        .withBean(ProcessingJobLifecycleService.class, () -> lifecycle)
        .withBean("taskScheduler", TaskScheduler.class, () -> scheduler);

    @Test
    void defaultSchedulesTheUnchangedRecoveryOperationEveryMinute() {
        assertScheduled(contexts, Duration.ofMinutes(1));
    }

    @Test
    void explicitEnablementPreservesTheConfiguredFixedDelay() {
        assertScheduled(contexts.withPropertyValues(
            "app.media.processing.stage-lease-sweep-enabled=true",
            "app.media.processing.stage-lease-sweep-ms=12345"), Duration.ofMillis(12345));
    }

    @Test
    void disablingOnlyTheTriggerKeepsRecoveryAvailableWithoutRegisteringAnAsyncSweep() {
        contexts.withPropertyValues("app.media.processing.stage-lease-sweep-enabled=false")
            .run(context -> {
                assertThat(context).hasNotFailed()
                    .doesNotHaveBean(ProcessingJobLeaseSweepScheduler.class)
                    .hasSingleBean(ProcessingJobLifecycleService.class);
                assertThat(context.getBean(ScheduledAnnotationBeanPostProcessor.class).getScheduledTasks())
                    .isEmpty();
                verifyNoInteractions(scheduler, lifecycle);

                context.getBean(ProcessingJobLifecycleService.class).expireAbandonedStages();
                verify(lifecycle).expireAbandonedStages();
            });
    }

    @Test
    void closingTheContextCancelsTheRegisteredTrigger() {
        ScheduledFuture<?> future = scheduledFuture();
        contexts.run(context -> assertThat(
            context.getBean(ScheduledAnnotationBeanPostProcessor.class).getScheduledTasks()).hasSize(1));
        verify(future).cancel(false);
    }

    private void assertScheduled(ApplicationContextRunner runner, Duration delay) {
        scheduledFuture();
        Instant beforeRegistration = Instant.now();
        runner.run(context -> {
            assertThat(context).hasNotFailed().hasSingleBean(ProcessingJobLeaseSweepScheduler.class);
            assertThat(context.getBean(ScheduledAnnotationBeanPostProcessor.class).getScheduledTasks())
                .hasSize(1);
            var task = ArgumentCaptor.forClass(Runnable.class);
            var start = ArgumentCaptor.forClass(Instant.class);
            verify(scheduler).scheduleWithFixedDelay(task.capture(), start.capture(), eq(delay));
            // Spring's TaskSchedulerRouter owns its clock, not the selected scheduler.
            assertThat(start.getValue()).isBetween(beforeRegistration, Instant.now());
            verifyNoInteractions(lifecycle);
            task.getValue().run();
            verify(lifecycle).expireAbandonedStages();
        });
    }

    private ScheduledFuture<?> scheduledFuture() {
        ScheduledFuture<?> future = mock(ScheduledFuture.class);
        when(scheduler.scheduleWithFixedDelay(any(Runnable.class), any(Instant.class), any(Duration.class)))
            .thenAnswer(invocation -> future);
        return future;
    }

    @Configuration(proxyBeanMethods = false)
    @EnableScheduling
    static class Scheduling { }
}
