package com.sme.meetingassistant.api.notification;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.ObjectMapper;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;

/** Default-disabled notification integration must not suppress audit events. */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
@TestPropertySource(properties = {
        "app.notification.action-item-assignment-enabled=false",
        "app.notification.action-item-assignment-delivery-enabled=false",
        "app.email.delivery.worker-enabled=false"
})
class ActionItemAssignmentFeatureGateIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;

    @Test
    void disablingNotificationLeavesCanonicalAssignmentEventButNoEmailIntent() throws Exception {
        UUID actor = UUID.randomUUID(), meeting = UUID.randomUUID();
        String email = "ai08-gate-" + actor + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'AI08 gate test','test-only','EMPLOYEE','ACTIVE')
            """, actor, email, email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'AI08 gated meeting',?,?)
            """, meeting, actor, actor);

        var response = mvc.perform(post("/api/v1/action-items")
                .principal(() -> actor.toString())
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(java.util.Map.of(
                    "meetingId", meeting, "title", "Official without email",
                    "assigneeUserId", actor))))
            .andExpect(status().isCreated()).andReturn();
        UUID item = UUID.fromString(json.readTree(
            response.getResponse().getContentAsString()).path("data").path("id").asText());
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM action_item_assignment_events WHERE action_item_id=?
            """, Integer.class, item)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries
             WHERE notification_type='ACTION_ITEM_ASSIGNED' AND recipient_user_id=?
            """, Integer.class, actor)).isZero();
    }
}
