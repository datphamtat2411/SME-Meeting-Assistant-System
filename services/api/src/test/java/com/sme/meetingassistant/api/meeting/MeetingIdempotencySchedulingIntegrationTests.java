package com.sme.meetingassistant.api.meeting;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.meeting.idempotency.MeetingCreationIdempotencyService;
import com.sme.meetingassistant.api.meeting.idempotency.MeetingCreationIdempotencySchedulingConfiguration;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Import;
import org.springframework.scheduling.annotation.ScheduledAnnotationBeanPostProcessor;
import org.springframework.scheduling.support.ScheduledMethodRunnable;
import org.springframework.test.context.ActiveProfiles;

/**
 * Pre-merge T04 regression: idempotency expiry housekeeping cannot silently
 * disappear when unrelated Email and Auth scheduling are both turned off.
 */
@ActiveProfiles("test")
@SpringBootTest(properties = {
    "app.email.delivery.worker-enabled=false",
    "app.auth.token-retention.enabled=false"
})
@Import(PostgresTestConfiguration.class)
class MeetingIdempotencySchedulingIntegrationTests {
    @Autowired ApplicationContext context;

    @Test void idempotencyExpiryCleanupIsScheduledEvenWhenOtherSchedulersAreDisabled() {
        assertThat(context.getBeansOfType(MeetingCreationIdempotencySchedulingConfiguration.class))
            .hasSize(1);
        ScheduledAnnotationBeanPostProcessor processor =
            context.getBean(ScheduledAnnotationBeanPostProcessor.class);
        assertThat(processor.getScheduledTasks())
            .anySatisfy(task -> {
                assertThat(task.getTask().getRunnable())
                    .isInstanceOfSatisfying(ScheduledMethodRunnable.class, runnable -> {
                        assertThat(runnable.getTarget())
                            .isInstanceOf(MeetingCreationIdempotencyService.class);
                        assertThat(runnable.getMethod().getName()).isEqualTo("removeExpired");
                    });
            });
    }
}
