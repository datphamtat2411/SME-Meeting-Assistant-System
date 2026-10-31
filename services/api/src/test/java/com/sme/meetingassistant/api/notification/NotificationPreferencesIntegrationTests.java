package com.sme.meetingassistant.api.notification;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.meeting.entity.MeetingEntity;
import com.sme.meetingassistant.api.meeting.repository.MeetingRepository;
import com.sme.meetingassistant.api.meeting.notification.MeetingNotificationService;
import com.sme.meetingassistant.api.notification.application.ActionItemAssignmentNotificationPort;
import com.sme.meetingassistant.api.notification.email.TransactionalEmailDeliveryWorker;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.AccountStatus;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import java.security.Principal;
import java.time.OffsetDateTime;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.context.annotation.Import;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.times;

@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
@Transactional
class NotificationPreferencesIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper mapper;
    @Autowired JdbcTemplate jdbc;
    @Autowired UserRepository users;
    @Autowired MeetingRepository meetings;
    @Autowired MeetingNotificationService meetingNotifications;
    @Autowired ActionItemAssignmentNotificationPort actionItemNotifications;
    @Autowired TransactionalEmailDeliveryWorker deliveryWorker;
    @MockitoBean JavaMailSender smtp;

    @Test
    void preferencesAreAuthenticatedScopedAndPatchableWithEnabledDefaults() throws Exception {
        UserEntity first = activeUser();
        UserEntity second = activeUser();

        mvc.perform(get("/api/v1/me/preferences"))
            .andExpect(status().isUnauthorized());

        JsonNode defaults = body(mvc.perform(get("/api/v1/me/preferences")
                .principal(principal(first)))
            .andExpect(status().isOk()).andReturn());
        assertThat(defaults.path("data").path("meetingEmailEnabled").asBoolean()).isTrue();
        assertThat(defaults.path("data").path("actionItemEmailEnabled").asBoolean()).isTrue();
        assertThat(defaults.path("data").path("timezone").isNull()).isTrue();

        JsonNode updated = body(mvc.perform(patch("/api/v1/me/preferences")
                .principal(principal(first)).contentType(MediaType.APPLICATION_JSON)
                .content("""
                    {"timezone":"Asia/Ho_Chi_Minh","locale":"vi-VN","meetingEmailEnabled":false}
                    """))
            .andExpect(status().isOk()).andReturn());
        assertThat(updated.path("data").path("timezone").asText()).isEqualTo("Asia/Ho_Chi_Minh");
        assertThat(updated.path("data").path("locale").asText()).isEqualTo("vi-VN");
        assertThat(updated.path("data").path("meetingEmailEnabled").asBoolean()).isFalse();
        assertThat(updated.path("data").path("actionItemEmailEnabled").asBoolean()).isTrue();

        JsonNode isolated = body(mvc.perform(get("/api/v1/me/preferences")
                .principal(principal(second)))
            .andExpect(status().isOk()).andReturn());
        assertThat(isolated.path("data").path("meetingEmailEnabled").asBoolean()).isTrue();

        mvc.perform(patch("/api/v1/me/preferences").principal(principal(first))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"timezone\":\"Mars/Olympus\"}"))
            .andExpect(status().isUnprocessableEntity());
    }

    @Test
    void actionItemAssignmentIsIdempotentAndUsesSharedEmailWorker() {
        UserEntity assignee = activeUser();
        UUID eventId = UUID.randomUUID();
        UUID actionItemId = UUID.randomUUID();

        actionItemNotifications.enqueueAssigned(eventId, actionItemId, assignee.getId(), assignee.getEmail());
        actionItemNotifications.enqueueAssigned(eventId, actionItemId, assignee.getId(), assignee.getEmail());

        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM email_deliveries
             WHERE notification_type='ACTION_ITEM_ASSIGNED' AND related_entity_id=?
            """, Integer.class, actionItemId)).isEqualTo(1);
        assertThat(deliveryWorker.deliverOne()).isTrue();
        assertThat(jdbc.queryForObject("""
            SELECT status FROM email_deliveries WHERE notification_type='ACTION_ITEM_ASSIGNED'
            """, String.class)).isEqualTo("SENT");
        verify(smtp, times(1)).send(any(SimpleMailMessage.class));
    }

    @Test
    void optedOutMeetingAndActionItemEventsAreRecordedAsSkippedWithoutSending() {
        UserEntity recipient = activeUser();
        jdbc.update("""
            INSERT INTO user_preferences(user_id,meeting_email_enabled,action_item_email_enabled,
                created_at,updated_at) VALUES (?,false,false,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
            """, recipient.getId());

        UUID meetingId = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id,status,
                scheduled_start_at,scheduled_end_at)
            VALUES (?, 'Private meeting title', ?, ?, 'SCHEDULED', ?, ?)
            """, meetingId, recipient.getId(), recipient.getId(),
            OffsetDateTime.parse("2030-12-22T09:00:00Z"), OffsetDateTime.parse("2030-12-22T10:00:00Z"));
        MeetingEntity meeting = meetings.findById(meetingId).orElseThrow();
        meetingNotifications.enqueue(meeting, "MEETING_SCHEDULED");
        actionItemNotifications.enqueueAssigned(UUID.randomUUID(), UUID.randomUUID(),
            recipient.getId(), recipient.getEmail());

        assertThat(jdbc.queryForList("""
            SELECT status FROM email_deliveries WHERE recipient_user_id=?
            """, String.class, recipient.getId())).containsOnly("SKIPPED");
        assertThat(jdbc.queryForList("""
            SELECT skip_reason FROM email_deliveries WHERE recipient_user_id=?
            """, String.class, recipient.getId())).containsOnly("USER_PREFERENCE_DISABLED");
        assertThat(deliveryWorker.deliverOne()).isFalse();
        verifyNoInteractions(smtp);
    }

    private UserEntity activeUser() {
        UserEntity user = new UserEntity("notice-" + UUID.randomUUID() + "@example.com",
            "Notification test", GlobalRole.EMPLOYEE, null);
        ReflectionTestUtils.setField(user, "passwordHash", "fixture-not-a-production-password");
        ReflectionTestUtils.setField(user, "accountStatus", AccountStatus.ACTIVE);
        return users.saveAndFlush(user);
    }

    private static Principal principal(UserEntity user) {
        return () -> user.getId().toString();
    }

    private JsonNode body(MvcResult result) throws Exception {
        return mapper.readTree(result.getResponse().getContentAsString());
    }
}
