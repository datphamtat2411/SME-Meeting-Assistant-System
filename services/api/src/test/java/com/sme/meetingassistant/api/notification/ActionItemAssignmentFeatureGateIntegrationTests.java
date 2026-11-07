package com.sme.meetingassistant.api.notification;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.actionitems.ActionItemService;
import com.sme.meetingassistant.api.actionitems.dto.CreateActionItemRequest;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
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
@Import(PostgresTestConfiguration.class)
@TestPropertySource(properties = {
        "app.notification.action-item-assignment-enabled=false",
        "app.notification.action-item-assignment-delivery-enabled=false",
        "app.email.delivery.worker-enabled=false"
})
class ActionItemAssignmentFeatureGateIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired ActionItemService service;

    @Test
    void disablingNotificationLeavesCanonicalAssignmentEventButNoEmailIntent() {
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

        UUID item = service.createManual(actor,
                new CreateActionItemRequest(meeting,"Official without email",null,actor,null)).id();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM action_item_assignment_events WHERE action_item_id=?
            """, Integer.class, item)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries
             WHERE notification_type='ACTION_ITEM_ASSIGNED' AND recipient_user_id=?
            """, Integer.class, actor)).isZero();
    }
}
