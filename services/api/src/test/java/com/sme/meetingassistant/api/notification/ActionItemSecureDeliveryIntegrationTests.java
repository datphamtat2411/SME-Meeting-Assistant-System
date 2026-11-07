package com.sme.meetingassistant.api.notification;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.actionitems.application.ActionItemAssignmentEligibility;
import com.sme.meetingassistant.api.notification.email.ActionItemAssignedEmailHandler;
import com.sme.meetingassistant.api.notification.email.TransactionalEmailDeliveryWorker;
import com.sme.meetingassistant.api.notification.email.TransactionalEmailHandler;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mail.MailSendException;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.ObjectMapper;

/**
 * AI-08.4: no enclosing test transaction. Commands commit through MockMvc,
 * and the shared delivery worker observes fresh PostgreSQL state.
 * A mock SMTP provider verifies handoffs without real email.
 */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
@TestPropertySource(properties = {
    "app.notification.action-item-assignment-enabled=true",
    "app.notification.action-item-assignment-delivery-enabled=true",
    "app.email.delivery.worker-enabled=false"
})
class ActionItemSecureDeliveryIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired TransactionalEmailDeliveryWorker worker;
    @Autowired ActionItemAssignedEmailHandler assignmentHandler;
    @Autowired ActionItemAssignmentEligibility eligibility;
    @MockitoBean JavaMailSender smtp;

    private UUID actor, a, b, meeting;
    private String aEmail, bEmail;

    @BeforeEach
    void seed() {
        // Isolation from preceding independently committed commands in this context.
        jdbc.update("""
            UPDATE email_deliveries
               SET status='SKIPPED',skip_reason='TEST_ISOLATION',next_attempt_at=NULL,
                   last_error_code=NULL,last_error_summary=NULL,updated_at=clock_timestamp()
             WHERE notification_type='ACTION_ITEM_ASSIGNED'
               AND status IN ('PENDING','FAILED','SENDING')
            """);
        actor = activeUser();
        a = activeUser();
        b = activeUser();
        aEmail = address(a);
        bEmail = address(b);
        meeting = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'AI08.4 private meeting agenda',?,?)
            """, meeting, actor, actor);
    }

    @Test
    void officialAssignmentPassesSendTimeChecksAndSendsOnlyMinimalContent() throws Exception {
        MvcResult created = create(a);
        UUID item = id(created), event = event(item);
        var prepared = assignmentHandler.prepare(new TransactionalEmailHandler.DeliveryContext(
            event, "ACTION_ITEM_ASSIGNMENT", a, aEmail));
        assertThat(prepared.content()).isPresent();
        assertThat(assignmentHandler.compose(event, aEmail)).isEmpty(); // no recipient ID
        assertThat(eligibility.isCurrentOfficialAssignment(event, a)).isTrue();

        assertThat(worker.deliverOne()).isTrue();
        assertThat(deliveryStatus(event)).isEqualTo("SENT");
        assertThat(jdbc.queryForObject("""
            SELECT attempt_count FROM email_deliveries WHERE related_entity_id=?
            """, Integer.class, event)).isEqualTo(1);
        ArgumentCaptor<SimpleMailMessage> capture = ArgumentCaptor.forClass(SimpleMailMessage.class);
        verify(smtp).send(capture.capture());
        assertThat(capture.getValue().getTo()).containsExactly(aEmail);
        assertThat(capture.getValue().getSubject()).isEqualTo("Action item assigned");
        assertThat(capture.getValue().getText())
            .doesNotContain("AI08.4 private meeting agenda", item.toString(),
                event.toString(), aEmail);
    }

    @Test
    void optOutAfterEnqueueSkipsMailWithDistinctReason() throws Exception {
        UUID event = event(id(create(a)));
        jdbc.update("""
            INSERT INTO user_preferences(user_id,action_item_email_enabled)
            VALUES (?,false)
            ON CONFLICT (user_id) DO UPDATE SET action_item_email_enabled=false
            """, a);
        assertThat(worker.deliverOne()).isTrue();
        assertThat(deliveryStatus(event)).isEqualTo("SKIPPED");
        assertThat(reason(event)).isEqualTo("USER_PREFERENCE_DISABLED");
        verifyNoInteractions(smtp);
    }

    @Test
    void changedEmailAndInactiveAccountCannotReceiveStaleMail() throws Exception {
        UUID original = event(id(create(a)));
        String next = "updated-" + a + "@example.invalid";
        jdbc.update("""
            UPDATE users SET email=?,email_normalized=?,version=version+1 WHERE id=?
            """, next, next, a);
        assertThat(worker.deliverOne()).isTrue();
        assertThat(deliveryStatus(original)).isEqualTo("SKIPPED");
        assertThat(reason(original)).isEqualTo("RECIPIENT_NO_LONGER_ELIGIBLE");

        UUID second = event(id(create(b)));
        jdbc.update("UPDATE users SET account_status='INACTIVE',version=version+1 WHERE id=?", b);
        assertThat(worker.deliverOne()).isTrue();
        assertThat(deliveryStatus(second)).isEqualTo("SKIPPED");
        assertThat(reason(second)).isEqualTo("RECIPIENT_NO_LONGER_ELIGIBLE");
        verifyNoInteractions(smtp);
    }

    @Test
    void reassignmentAtoBtoASupersedesOldQueueAndDoesNotResurrectFirstA() throws Exception {
        MvcResult created = create(a);
        UUID item = id(created), first = event(item);
        MvcResult reassigned = changeAssignee(item, tag(created), b);
        UUID second = event(item);
        assertThat(second).isNotEqualTo(first);
        assertThat(deliveryStatus(first)).isEqualTo("SKIPPED");
        assertThat(reason(first)).isEqualTo("SUPERSEDED_BY_ACTION_ITEM_CHANGE");

        changeAssignee(item, tag(reassigned), a);
        UUID third = event(item);
        assertThat(third).isNotIn(first, second);
        assertThat(deliveryStatus(second)).isEqualTo("SKIPPED");
        assertThat(deliveryStatus(third)).isEqualTo("PENDING");
        assertThat(eligibility.isCurrentOfficialAssignment(first, a)).isFalse();
        assertThat(eligibility.isCurrentOfficialAssignment(second, b)).isFalse();
        assertThat(eligibility.isCurrentOfficialAssignment(third, a)).isTrue();

        assertThat(worker.deliverOne()).isTrue();
        assertThat(deliveryStatus(third)).isEqualTo("SENT");
        assertThat(worker.deliverOne()).isFalse();
        ArgumentCaptor<SimpleMailMessage> capture = ArgumentCaptor.forClass(SimpleMailMessage.class);
        verify(smtp, times(1)).send(capture.capture());
        assertThat(capture.getValue().getTo()).containsExactly(aEmail);
    }

    @Test
    void completeThenReopenCannotResurrectOriginalEmailOrAssignmentVersion() throws Exception {
        MvcResult created = create(a);
        UUID item = id(created), original = event(item);
        MvcResult done = command(item, "complete", tag(created));
        assertThat(deliveryStatus(original)).isEqualTo("SKIPPED");
        assertThat(reason(original)).isEqualTo("SUPERSEDED_BY_ACTION_ITEM_CHANGE");
        assertThat(revocationCount(original)).isEqualTo(1);
        command(item, "reopen", tag(done));
        assertThat(eligibility.isCurrentOfficialAssignment(original, a)).isFalse();
        assertThat(worker.deliverOne()).isFalse();
        verifyNoInteractions(smtp);

        // Reopening is not assignment. A new manager reassignment is.
        MvcResult afterReopen = detail(item);
        changeAssignee(item, tag(afterReopen), b);
        UUID newEvent = event(item);
        assertThat(newEvent).isNotEqualTo(original);
        assertThat(eligibility.isCurrentOfficialAssignment(newEvent, b)).isTrue();
        assertThat(revocationCount(original)).isEqualTo(1);
    }

    @Test
    void cancelledAssignmentSupersedesFailedRetryAndClearsBackoff() throws Exception {
        MvcResult created = create(a);
        UUID item = id(created), original = event(item);
        doThrow(new MailSendException("provider response must not be recorded"))
            .when(smtp).send(any(SimpleMailMessage.class));
        assertThat(worker.deliverOne()).isTrue();
        assertThat(deliveryStatus(original)).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("""
            SELECT next_attempt_at IS NOT NULL FROM email_deliveries WHERE related_entity_id=?
            """, Boolean.class, original)).isTrue();

        command(item, "cancel", tag(created));
        assertThat(deliveryStatus(original)).isEqualTo("SKIPPED");
        assertThat(reason(original)).isEqualTo("SUPERSEDED_BY_ACTION_ITEM_CHANGE");
        assertThat(jdbc.queryForObject("""
            SELECT next_attempt_at FROM email_deliveries WHERE related_entity_id=?
            """, java.time.OffsetDateTime.class, original)).isNull();
        assertThat(jdbc.queryForObject("""
            SELECT last_error_code FROM email_deliveries WHERE related_entity_id=?
            """, String.class, original)).isNull();
        assertThat(revocationCount(original)).isEqualTo(1);
        assertThat(worker.deliverOne()).isFalse();
        verify(smtp, times(1)).send(any(SimpleMailMessage.class));
    }

    @Test
    void reclaimedSendingAfterTerminalReopenIsStillSkippedByRevocation() throws Exception {
        MvcResult created = create(a);
        UUID item = id(created), original = event(item);
        jdbc.update("""
            UPDATE email_deliveries
               SET status='SENDING',attempt_count=1,
                   updated_at=clock_timestamp()-INTERVAL '10 minutes'
             WHERE related_entity_id=?
            """, original);
        MvcResult done = command(item, "complete", tag(created));
        command(item, "reopen", tag(done));
        assertThat(deliveryStatus(original)).isEqualTo("SENDING");
        assertThat(eligibility.isCurrentOfficialAssignment(original, a)).isFalse();

        assertThat(worker.deliverOne()).isTrue(); // expired lease reclaimed
        assertThat(deliveryStatus(original)).isEqualTo("SKIPPED");
        assertThat(jdbc.queryForObject("""
            SELECT attempt_count FROM email_deliveries WHERE related_entity_id=?
            """, Integer.class, original)).isEqualTo(2);
        verifyNoInteractions(smtp);
    }

    @Test
    void smtpTransientFailureRetriesSameBusinessEventWithoutDuplicateIntent() throws Exception {
        UUID ev = event(id(create(a)));
        doThrow(new MailSendException("secret SMTP trace"))
            .doNothing().when(smtp).send(any(SimpleMailMessage.class));
        assertThat(worker.deliverOne()).isTrue();
        assertThat(deliveryStatus(ev)).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("""
            SELECT last_error_summary FROM email_deliveries WHERE related_entity_id=?
            """, String.class, ev)).isNull();
        assertThat(worker.deliverOne()).isFalse();
        jdbc.update("""
            UPDATE email_deliveries
               SET next_attempt_at=clock_timestamp()-INTERVAL '1 minute'
             WHERE related_entity_id=?
            """, ev);
        assertThat(worker.deliverOne()).isTrue();
        assertThat(deliveryStatus(ev)).isEqualTo("SENT");
        assertThat(jdbc.queryForObject("""
            SELECT attempt_count FROM email_deliveries WHERE related_entity_id=?
            """, Integer.class, ev)).isEqualTo(2);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries WHERE related_entity_id=?
            """, Integer.class, ev)).isEqualTo(1);
        verify(smtp, times(2)).send(any(SimpleMailMessage.class));
    }

    @Test
    void repeatedSmtpFailureReachesDeadWithoutPersistingProviderDetails() throws Exception {
        UUID ev = event(id(create(a)));
        doThrow(new MailSendException("private SMTP response 5xx secret"))
            .when(smtp).send(any(SimpleMailMessage.class));
        for (int attempt = 1; attempt <= 5; attempt++) {
            if (attempt > 1) {
                jdbc.update("""
                    UPDATE email_deliveries
                       SET next_attempt_at=clock_timestamp()-INTERVAL '1 minute'
                     WHERE related_entity_id=?
                    """, ev);
            }
            assertThat(worker.deliverOne()).isTrue();
            assertThat(deliveryStatus(ev)).isEqualTo(attempt == 5 ? "DEAD" : "FAILED");
        }
        assertThat(worker.deliverOne()).isFalse();
        assertThat(jdbc.queryForObject("""
            SELECT attempt_count FROM email_deliveries WHERE related_entity_id=?
            """, Integer.class, ev)).isEqualTo(5);
        assertThat(jdbc.queryForObject("""
            SELECT last_error_code FROM email_deliveries WHERE related_entity_id=?
            """, String.class, ev)).isEqualTo("SMTP_DELIVERY_FAILED");
        assertThat(jdbc.queryForObject("""
            SELECT last_error_summary FROM email_deliveries WHERE related_entity_id=?
            """, String.class, ev)).isNull();
        verify(smtp, times(5)).send(any(SimpleMailMessage.class));
    }

    @Test
    void corruptQueueRecipientIdentityIsRejectedEvenWhenEventExists() throws Exception {
        UUID ev = event(id(create(a)));
        jdbc.update("""
            UPDATE email_deliveries SET recipient_user_id=?,recipient_email=?
            WHERE related_entity_id=?
            """, b, bEmail, ev);
        assertThat(worker.deliverOne()).isTrue();
        assertThat(deliveryStatus(ev)).isEqualTo("SKIPPED");
        assertThat(reason(ev)).isEqualTo("ACTION_NO_LONGER_ELIGIBLE");
        verifyNoInteractions(smtp);
    }

    @Test
    void staleSmtpAttemptCannotOverwriteNewlyClaimedGeneration() throws Exception {
        UUID ev = event(id(create(a)));
        AtomicInteger sends = new AtomicInteger();
        doAnswer(invocation -> {
            if (sends.incrementAndGet() == 1) {
                // A hypothetical SMTP hang longer than the five-minute lease:
                // another worker reclaims and finishes attempt 2.
                jdbc.update("""
                    UPDATE email_deliveries
                       SET updated_at=clock_timestamp()-INTERVAL '10 minutes'
                     WHERE related_entity_id=? AND status='SENDING'
                    """, ev);
                assertThat(worker.deliverOne()).isTrue();
            }
            return null;
        }).when(smtp).send(any(SimpleMailMessage.class));

        assertThat(worker.deliverOne()).isTrue();
        assertThat(deliveryStatus(ev)).isEqualTo("SENT");
        assertThat(jdbc.queryForObject("""
            SELECT attempt_count FROM email_deliveries WHERE related_entity_id=?
            """, Integer.class, ev)).isEqualTo(2);
        assertThat(sends.get()).isEqualTo(2); // at-least-once, never claim exactly-once
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries WHERE related_entity_id=?
            """, Integer.class, ev)).isEqualTo(1);
    }

    private UUID activeUser() {
        UUID id = UUID.randomUUID();
        String email = "ai08-secure-" + id + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,
                global_role,account_status)
            VALUES (?,?,?,'AI08.4 user','test-only','EMPLOYEE','ACTIVE')
            """, id, email, email);
        return id;
    }

    private String address(UUID user) {
        return jdbc.queryForObject("SELECT email FROM users WHERE id=?", String.class, user);
    }

    private Principal principal() { return () -> actor.toString(); }

    private MvcResult create(UUID assignee) throws Exception {
        return mvc.perform(post("/api/v1/action-items")
            .principal(principal()).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of(
                "meetingId", meeting, "title", "Classified project action", "assigneeUserId", assignee))))
            .andExpect(status().isCreated()).andReturn();
    }

    private MvcResult command(UUID item, String cmd, String tag) throws Exception {
        return mvc.perform(post("/api/v1/action-items/{id}/{cmd}", item, cmd)
            .principal(principal()).header(HttpHeaders.IF_MATCH, tag))
            .andExpect(status().isOk()).andReturn();
    }

    private MvcResult changeAssignee(UUID item, String tag, UUID assignee) throws Exception {
        return mvc.perform(patch("/api/v1/action-items/{id}", item)
            .principal(principal()).header(HttpHeaders.IF_MATCH, tag)
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("assigneeUserId", assignee))))
            .andExpect(status().isOk()).andReturn();
    }

    private MvcResult detail(UUID item) throws Exception {
        return mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
            .get("/api/v1/action-items/{id}", item)
            .principal(principal())).andExpect(status().isOk()).andReturn();
    }

    private UUID id(MvcResult response) throws Exception {
        return UUID.fromString(json.readTree(response.getResponse().getContentAsString())
            .path("data").path("id").asText());
    }

    private String tag(MvcResult response) {
        return response.getResponse().getHeader(HttpHeaders.ETAG);
    }

    private UUID event(UUID item) {
        return jdbc.queryForObject("""
            SELECT id FROM action_item_assignment_events WHERE action_item_id=?
            ORDER BY action_item_version DESC LIMIT 1
            """, UUID.class, item);
    }

    private String deliveryStatus(UUID event) {
        return jdbc.queryForObject("""
            SELECT status FROM email_deliveries WHERE related_entity_id=?
              AND related_entity_type='ACTION_ITEM_ASSIGNMENT'
            """, String.class, event);
    }

    private String reason(UUID event) {
        return jdbc.queryForObject("""
            SELECT skip_reason FROM email_deliveries WHERE related_entity_id=?
            """, String.class, event);
    }

    private int revocationCount(UUID event) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM action_item_assignment_revocations WHERE event_id=?
            """, Integer.class, event);
    }
}
