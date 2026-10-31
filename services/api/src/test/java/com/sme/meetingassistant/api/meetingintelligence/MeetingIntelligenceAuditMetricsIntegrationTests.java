package com.sme.meetingassistant.api.meetingintelligence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.meetingintelligence.service.MeetingIntelligenceAudit;
import com.sme.meetingassistant.api.meetingintelligence.service.MeetingIntelligenceMetrics;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** MI-11 audits are committed atomically and telemetry is rollback-safe. */
@ActiveProfiles("test")
@SpringBootTest(properties = {"app.media.outbox.enabled=false",
    "app.media.processing.stage-lease-sweep-ms=3600000"})
@Import(PostgresTestConfiguration.class)
class MeetingIntelligenceAuditMetricsIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired PlatformTransactionManager transactionManager;
    @Autowired MeetingIntelligenceAudit audit;
    @Autowired MeetingIntelligenceMetrics metrics;
    @Autowired MeterRegistry registry;
    private UUID actor;
    private UUID meeting;

    @BeforeEach
    void setup() {
        actor = UUID.randomUUID();
        meeting = UUID.randomUUID();
        String email = "mi11-" + actor + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'MI11 audit user','test-only','EMPLOYEE','ACTIVE')
            """, actor, email, email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'MI11 audit meeting',?,?)
            """, meeting, actor, actor);
    }

    private TransactionTemplate tx() { return new TransactionTemplate(transactionManager); }

    private int events() {
        return jdbc.queryForObject("SELECT count(*) FROM audit_events WHERE meeting_id=?",
            Integer.class, meeting);
    }

    @Test
    void humanAndServiceAuditUseTrustedActorTypesAndOnlyAllowlistedMetadata() {
        UUID before = UUID.randomUUID(), after = UUID.randomUUID();
        UUID job = UUID.randomUUID(), stage = UUID.randomUUID();
        UUID receipt = UUID.randomUUID(), transcript = UUID.randomUUID();
        tx().executeWithoutResult(status -> {
            audit.summaryEdited(actor, meeting, before, after, 1, 2, false);
            audit.resultAccepted(meeting, receipt, job, stage, transcript, 3, "SUMMARY", 1);
        });
        assertThat(events()).isEqualTo(2);
        assertThat(jdbc.queryForObject("""
            SELECT actor_type FROM audit_events WHERE meeting_id=? AND action_code='MI_SUMMARY_EDITED'
            """, String.class, meeting)).isEqualTo("USER");
        assertThat(jdbc.queryForObject("""
            SELECT actor_user_id FROM audit_events WHERE meeting_id=? AND action_code='MI_SUMMARY_EDITED'
            """, UUID.class, meeting)).isEqualTo(actor);
        assertThat(jdbc.queryForObject("""
            SELECT actor_type FROM audit_events WHERE meeting_id=? AND action_code='MI_AI_RESULT_ACCEPTED'
            """, String.class, meeting)).isEqualTo("SERVICE");
        assertThat(jdbc.queryForObject("""
            SELECT actor_user_id IS NULL FROM audit_events
            WHERE meeting_id=? AND action_code='MI_AI_RESULT_ACCEPTED'
            """, Boolean.class, meeting)).isTrue();
        String metadata = jdbc.queryForObject("""
            SELECT metadata::text FROM audit_events
            WHERE meeting_id=? AND action_code='MI_AI_RESULT_ACCEPTED'
            """, String.class, meeting);
        assertThat(metadata).contains(stage.toString(), job.toString(), "SUMMARY")
            .doesNotContain("rawText", "prompt", "accessToken", "content");
    }

    @Test
    void failedTransactionCannotLeaveAuditOrSuccessCounter() {
        double baseline = counter("ai_result_ingestion", "ACCEPTED");
        assertThatThrownBy(() -> tx().executeWithoutResult(status -> {
            audit.decisionCreated(actor, meeting, UUID.randomUUID(), 0);
            metrics.committed("ai_result_ingestion", "ACCEPTED");
            throw new IllegalStateException("simulate failed canonical write");
        })).isInstanceOf(IllegalStateException.class);
        assertThat(events()).isZero();
        assertThat(counter("ai_result_ingestion", "ACCEPTED")).isEqualTo(baseline);
    }

    @Test
    void successfulCommitAndRejectedResultUseFixedMetricDimensions() {
        double accepted = counter("summary_regeneration", "ACCEPTED");
        double rejected = counter("ai_result_ingestion", "REJECTED");
        tx().executeWithoutResult(status ->
            metrics.committed("summary_regeneration", "ACCEPTED"));
        assertThat(counter("summary_regeneration", "ACCEPTED")).isEqualTo(accepted + 1);
        metrics.failure("ai_result_ingestion", new IllegalArgumentException("raw provider content must not be tagged"));
        assertThat(counter("ai_result_ingestion", "REJECTED")).isEqualTo(rejected + 1);
        assertThat(registry.find("meeting.intelligence.operations").counters())
            .allSatisfy(counter -> assertThat(counter.getId().getTag("meetingId")).isNull());
    }

    private double counter(String operation, String outcome) {
        return registry.counter("meeting.intelligence.operations",
            "operation", operation, "outcome", outcome).count();
    }
}
