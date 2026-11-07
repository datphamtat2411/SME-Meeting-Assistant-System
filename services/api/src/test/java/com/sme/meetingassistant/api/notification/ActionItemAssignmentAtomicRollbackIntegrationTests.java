package com.sme.meetingassistant.api.notification;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;

import com.sme.meetingassistant.api.notification.application.ActionItemAssignmentNotificationPort;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.ObjectMapper;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/** An intent-writer failure before commit cannot leave an orphan canonical event. */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
@TestPropertySource(properties = {
        "app.notification.action-item-assignment-enabled=true",
        "app.notification.action-item-assignment-delivery-enabled=false",
        "app.email.delivery.worker-enabled=false"
})
class ActionItemAssignmentAtomicRollbackIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @MockitoBean ActionItemAssignmentNotificationPort intentPort;

    private UUID actor;
    private UUID meeting;

    @BeforeEach
    void seed() {
        actor = UUID.randomUUID();
        meeting = UUID.randomUUID();
        String email = "ai08-atomic-" + actor + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'AI08 failure injection','test-only','EMPLOYEE','ACTIVE')
            """, actor, email, email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'AI08 atomic rollback',?,?)
            """, meeting, actor, actor);
    }

    @Test
    void failureToWriteIntentBeforeCommitRollsBackItemHistoryAndEvent() throws Exception {
        doThrow(new IllegalStateException("intent insert deliberately failed"))
                .when(intentPort).enqueueAssigned(any(), any(), any(), any());

        // A before-commit listener failure must surface as an HTTP 500 and
        // roll back the canonical write. Never weaken production authorization
        // to make an internal service call pass in a test without a principal.
        var response = mvc.perform(post("/api/v1/action-items")
                .principal(() -> actor.toString())
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(java.util.Map.of(
                    "meetingId", meeting, "title", "Must roll back",
                    "assigneeUserId", actor)))).andReturn();
        assertThat(response.getResponse().getStatus()).isEqualTo(500);

        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM action_items WHERE meeting_id=?
            """, Integer.class, meeting)).isZero();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM action_item_history h
             JOIN action_items item ON item.id=h.action_item_id WHERE item.meeting_id=?
            """, Integer.class, meeting)).isZero();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM action_item_assignment_events e
             JOIN action_items item ON item.id=e.action_item_id WHERE item.meeting_id=?
            """, Integer.class, meeting)).isZero();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries
             WHERE notification_type='ACTION_ITEM_ASSIGNED' AND recipient_user_id=?
            """, Integer.class, actor)).isZero();
    }
}
