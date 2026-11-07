package com.sme.meetingassistant.api.notification;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.notification.email.TransactionalEmailDeliveryWorker;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.mockito.ArgumentCaptor;
import tools.jackson.databind.ObjectMapper;

/**
 * AI-08.5: actual HTTP meeting transitions -> durable PostgreSQL queue ->
 * shared worker -> mock SMTP. No enclosing transaction and no external SMTP.
 */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
@TestPropertySource(properties = {
    "app.email.delivery.worker-enabled=false",
    "app.email.delivery.sender=notifications@example.com"
})
class MeetingEmailSendTimeIntegrationTests {
    static final String START = "2030-12-29T09:00:00Z";
    static final String END = "2030-12-29T10:00:00Z";
    static final String LATER = "2030-12-29T11:00:00Z";
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired TransactionalEmailDeliveryWorker worker;
    @MockitoBean JavaMailSender smtp;

    UUID organizer;
    String organizerEmail;

    @BeforeEach
    void setup() {
        // Avoid claiming unfinished meeting fixtures from unrelated integration tests.
        // Account/security and Action Items mail are explicitly untouched.
        jdbc.update("""
            UPDATE email_deliveries SET status='SKIPPED',
                skip_reason='TEST_FIXTURE_ISOLATION', updated_at=clock_timestamp()
             WHERE notification_type IN (
                'MEETING_SCHEDULED','MEETING_RESCHEDULED','MEETING_CANCELLED',
                'MEETING_PARTICIPANT_ADDED','MEETING_PARTICIPANT_REMOVED')
               AND status IN ('PENDING','FAILED')
            """);
        organizer = user();
        organizerEmail = email(organizer);
    }

    private static String email(UUID user) { return "ai085-" + user + "@example.invalid"; }
    private UUID user() {
        UUID id = UUID.randomUUID();
        String address = email(id);
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'AI08.5 recipient','test-only','EMPLOYEE','ACTIVE')
            """, id, address, address);
        return id;
    }
    private UUID userWithEmail(String address) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'AI08.5 recipient','test-only','EMPLOYEE','ACTIVE')
            """, id, address, address);
        return id;
    }
    private Principal actor() { return () -> organizer.toString(); }
    private String tag(MvcResult response) { return response.getResponse().getHeader(HttpHeaders.ETAG); }
    private UUID id(MvcResult r) throws Exception {
        return UUID.fromString(json.readTree(r.getResponse().getContentAsString())
                .path("data").path("id").asText());
    }
    private MvcResult draft(UUID... members) throws Exception {
        Map<String,Object> body = new LinkedHashMap<>();
        body.put("title", "Sensitive quarterly planning details");
        body.put("scheduledStartAt", START);
        body.put("scheduledEndAt", END);
        body.put("participantUserIds", List.of(members));
        return mvc.perform(post("/api/v1/meetings").principal(actor())
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(body)))
            .andExpect(status().isCreated()).andReturn();
    }
    private MvcResult command(UUID meeting, String action, String etag) throws Exception {
        return mvc.perform(post("/api/v1/meetings/{id}/{command}", meeting, action)
                .principal(actor()).header(HttpHeaders.IF_MATCH, etag))
            .andExpect(status().isOk()).andReturn();
    }
    private MvcResult edit(UUID meeting,String etag,Map<String,?> changes) throws Exception {
        return mvc.perform(patch("/api/v1/meetings/{id}",meeting)
                .principal(actor()).header(HttpHeaders.IF_MATCH,etag)
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(changes)))
            .andExpect(status().isOk()).andReturn();
    }
    private MvcResult add(UUID meeting,UUID who,String etag) throws Exception {
        return mvc.perform(post("/api/v1/meetings/{id}/participants",meeting)
                .principal(actor()).header(HttpHeaders.IF_MATCH,etag)
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("userId",who))))
            .andExpect(status().isCreated()).andReturn();
    }
    private MvcResult remove(UUID meeting,UUID who,String etag) throws Exception {
        return mvc.perform(delete("/api/v1/meetings/{id}/participants/{userId}",meeting,who)
                .principal(actor()).header(HttpHeaders.IF_MATCH,etag))
            .andExpect(status().isOk()).andReturn();
    }
    private UUID schedule() throws Exception {
        var created=draft();
        UUID meeting=id(created);
        command(meeting,"schedule",tag(created));
        return meeting;
    }
    private UUID intent(UUID meeting,String type,UUID recipient) {
        return jdbc.queryForObject("""
            SELECT id FROM email_deliveries
            WHERE related_entity_type='MEETING' AND related_entity_id=?
              AND notification_type=? AND recipient_user_id=?
            ORDER BY created_at DESC LIMIT 1
            """,UUID.class,meeting,type,recipient);
    }
    private String state(UUID intentId) {
        return jdbc.queryForObject("SELECT status FROM email_deliveries WHERE id=?",
                String.class,intentId);
    }
    private String reason(UUID intentId) {
        return jdbc.queryForObject("SELECT skip_reason FROM email_deliveries WHERE id=?",
                String.class,intentId);
    }
    private void optOut(UUID account) {
        jdbc.update("""
            INSERT INTO user_preferences(user_id,meeting_email_enabled,action_item_email_enabled)
            VALUES (?,false,false)
            ON CONFLICT (user_id) DO UPDATE SET meeting_email_enabled=false,
                                               action_item_email_enabled=false
            """,account);
    }
    private void skipOtherMeetingMail(UUID except) {
        jdbc.update("""
            UPDATE email_deliveries SET status='SKIPPED',skip_reason='TEST_FIXTURE_ISOLATION'
             WHERE notification_type LIKE 'MEETING_%' AND status IN ('PENDING','FAILED')
               AND id<>?
            """,except);
    }

    @Test
    void optedOutAfterScheduledEnqueueIsSkippedAtSmtpHandoff() throws Exception {
        UUID meeting=schedule();
        UUID queued=intent(meeting,"MEETING_SCHEDULED",organizer);
        optOut(organizer);
        assertThat(worker.deliverOne()).isTrue();
        assertThat(state(queued)).isEqualTo("SKIPPED");
        assertThat(reason(queued)).isEqualTo("USER_PREFERENCE_DISABLED");
        verifyNoInteractions(smtp);
    }

    @Test
    void optOutAfterCancellationEnqueueDoesNotSuppressBusinessCancellation() throws Exception {
        var created=draft();
        UUID meeting=id(created);
        var scheduled=command(meeting,"schedule",tag(created));
        command(meeting,"cancel",tag(scheduled));
        UUID queued=intent(meeting,"MEETING_CANCELLED",organizer);
        optOut(organizer);
        assertThat(worker.deliverOne()).isTrue();
        assertThat(state(queued)).isEqualTo("SKIPPED");
        assertThat(reason(queued)).isEqualTo("USER_PREFERENCE_DISABLED");
        assertThat(jdbc.queryForObject("SELECT status FROM meetings WHERE id=?",
                String.class,meeting)).isEqualTo("CANCELLED");
        verifyNoInteractions(smtp);
    }

    @Test
    void participantAddedAndRemovedMailAlsoHonorSendTimeOptOut() throws Exception {
        UUID member=user();
        var created=draft();
        UUID meeting=id(created);
        var scheduled=command(meeting,"schedule",tag(created));
        var added=add(meeting,member,tag(scheduled));
        UUID addIntent=jdbc.queryForObject("""
            SELECT id FROM email_deliveries WHERE notification_type='MEETING_PARTICIPANT_ADDED'
              AND recipient_user_id=?
            ORDER BY created_at DESC LIMIT 1
            """,UUID.class,member);
        optOut(member);
        skipOtherMeetingMail(addIntent);
        assertThat(worker.deliverOne()).isTrue();
        assertThat(state(addIntent)).isEqualTo("SKIPPED");
        assertThat(reason(addIntent)).isEqualTo("USER_PREFERENCE_DISABLED");

        jdbc.update("UPDATE user_preferences SET meeting_email_enabled=true WHERE user_id=?",member);
        var current = mvc.perform(get("/api/v1/meetings/{id}",meeting).principal(actor()))
            .andExpect(status().isOk()).andReturn();
        remove(meeting,member,tag(current));
        UUID removed=jdbc.queryForObject("""
            SELECT id FROM email_deliveries WHERE notification_type='MEETING_PARTICIPANT_REMOVED'
              AND recipient_user_id=?
            ORDER BY created_at DESC LIMIT 1
            """,UUID.class,member);
        assertThat(state(removed)).isEqualTo("PENDING");
        optOut(member);
        skipOtherMeetingMail(removed);
        assertThat(worker.deliverOne()).isTrue();
        assertThat(state(removed)).isEqualTo("SKIPPED");
        assertThat(reason(removed)).isEqualTo("USER_PREFERENCE_DISABLED");
        verifyNoInteractions(smtp);
    }

    @Test
    void alreadyClaimedScheduleBecomesStaleOnLaterMaterialReschedule() throws Exception {
        var created=draft();
        UUID meeting=id(created);
        var scheduled=command(meeting,"schedule",tag(created));
        UUID original=intent(meeting,"MEETING_SCHEDULED",organizer);
        jdbc.update("""
            UPDATE email_deliveries SET status='SENDING',attempt_count=1,
                updated_at=clock_timestamp()-INTERVAL '6 minutes'
            WHERE id=?
            """,original);
        edit(meeting,tag(scheduled),Map.of("scheduledEndAt",LATER));
        assertThat(state(original)).isEqualTo("SENDING");
        assertThat(worker.deliverOne()).isTrue();
        assertThat(state(original)).isEqualTo("SKIPPED");
        assertThat(reason(original)).isEqualTo("SUPERSEDED_BY_MEETING_CHANGE");
        verifyNoInteractions(smtp);
        UUID recent=intent(meeting,"MEETING_RESCHEDULED",organizer);
        assertThat(state(recent)).isEqualTo("PENDING");
        assertThat(worker.deliverOne()).isTrue();
        assertThat(state(recent)).isEqualTo("SENT");
        var email=ArgumentCaptor.forClass(SimpleMailMessage.class);
        verify(smtp).send(email.capture());
        assertThat(email.getValue().getSubject()).isEqualTo("Meeting rescheduled");
        assertThat(email.getValue().getText()).doesNotContain(
            "Sensitive quarterly planning details",meeting.toString(),START,END,LATER);
    }

    @Test
    void nonMaterialTitleEditMustNotObsoleteStillUsefulScheduledNotice() throws Exception {
        var created=draft();
        UUID meeting=id(created);
        var scheduled=command(meeting,"schedule",tag(created));
        UUID scheduledIntent=intent(meeting,"MEETING_SCHEDULED",organizer);
        edit(meeting,tag(scheduled),Map.of("title","Changed metadata only"));
        assertThat(worker.deliverOne()).isTrue();
        assertThat(state(scheduledIntent)).isEqualTo("SENT");
        var mail=ArgumentCaptor.forClass(SimpleMailMessage.class);
        verify(smtp).send(mail.capture());
        assertThat(mail.getValue().getText()).doesNotContain("Changed metadata only");
    }

    @Test
    void recipientEmailChangeAndAddressRecyclingCannotRetargetOldQueuedNotice()
            throws Exception {
        UUID meeting=schedule();
        UUID stale=intent(meeting,"MEETING_SCHEDULED",organizer);
        String originalAddress=organizerEmail;
        String changed="ai085-changed-"+UUID.randomUUID()+"@example.invalid";
        jdbc.update("UPDATE users SET email=?,email_normalized=? WHERE id=?",
                changed,changed,organizer);
        UUID another=userWithEmail(originalAddress);
        // This new account really IS a current meeting participant. The old
        // email-only compose() could otherwise wrongly authorize the stale intent.
        var detail=mvc.perform(get("/api/v1/meetings/{id}",meeting).principal(actor()))
            .andExpect(status().isOk()).andReturn();
        add(meeting,another,tag(detail));
        assertThat(worker.deliverOne()).isTrue();
        assertThat(state(stale)).isEqualTo("SKIPPED");
        assertThat(reason(stale)).isEqualTo("RECIPIENT_NO_LONGER_ELIGIBLE");
        verifyNoInteractions(smtp);
    }

    @Test
    void inactiveRecipientCannotReceivePendingMeetingEmail() throws Exception {
        UUID meeting=schedule();
        UUID pending=intent(meeting,"MEETING_SCHEDULED",organizer);
        jdbc.update("UPDATE users SET account_status='INACTIVE',deactivated_at=clock_timestamp() WHERE id=?",
                organizer);
        assertThat(worker.deliverOne()).isTrue();
        assertThat(state(pending)).isEqualTo("SKIPPED");
        assertThat(reason(pending)).isEqualTo("RECIPIENT_NO_LONGER_ELIGIBLE");
        verifyNoInteractions(smtp);
    }
}
