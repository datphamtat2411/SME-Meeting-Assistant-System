package com.sme.meetingassistant.api.notification.application;

import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** Persists assignment email intent atomically with the authoritative Action Items transaction. */
@ConditionalOnProperty(prefix = "app.notification", name = "action-item-assignment-enabled",
        havingValue = "true", matchIfMissing = false)
@Service
public class ActionItemAssignmentNotificationService implements ActionItemAssignmentNotificationPort {
    private final JdbcTemplate jdbc;
    private final EmailNotificationPreferenceLookup preferences;

    public ActionItemAssignmentNotificationService(JdbcTemplate jdbc,
            EmailNotificationPreferenceLookup preferences) {
        this.jdbc = jdbc;
        this.preferences = preferences;
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void enqueueAssigned(UUID eventId, UUID actionItemId, UUID assigneeUserId,
            String recipientEmail) {
        if (eventId == null || actionItemId == null || assigneeUserId == null
                || recipientEmail == null || recipientEmail.isBlank() || recipientEmail.length() > 320
                || recipientEmail.contains("\r") || recipientEmail.contains("\n")) {
            throw new IllegalArgumentException("Invalid action item assignment notification");
        }
        // A Java caller's UUID is not authority. Check the immutable DB event
        // before creating any durable email intent.
        Boolean canonical = jdbc.queryForObject("""
            SELECT EXISTS (
                SELECT 1 FROM action_item_assignment_events event
                WHERE event.id=? AND event.action_item_id=? AND event.assignee_user_id=?
            )
            """, Boolean.class, eventId, actionItemId, assigneeUserId);
        if (!Boolean.TRUE.equals(canonical)) {
            throw new IllegalStateException("Assignment email requires a real canonical event");
        }
        String dedupeKey = "action-item-assignment:" + eventId;
        boolean enabled = preferences.actionItemEmailEnabled(assigneeUserId);
        int inserted = jdbc.update("""
            INSERT INTO email_deliveries(id,notification_type,recipient_user_id,recipient_email,
                related_entity_type,related_entity_id,status,skip_reason,dedupe_key,
                attempt_count,created_at,updated_at)
            VALUES (?,'ACTION_ITEM_ASSIGNED',?,?,'ACTION_ITEM_ASSIGNMENT',?,?,?, ?,0,
                clock_timestamp(),clock_timestamp())
            ON CONFLICT (dedupe_key) DO NOTHING
            """, UUID.randomUUID(), assigneeUserId, recipientEmail, eventId,
            enabled ? "PENDING" : "SKIPPED", enabled ? null : "USER_PREFERENCE_DISABLED", dedupeKey);
        if (inserted == 0) validateReplay(dedupeKey, eventId, assigneeUserId, recipientEmail);
    }

    private void validateReplay(String dedupeKey, UUID eventId, UUID assigneeUserId,
            String recipientEmail) {
        List<Boolean> matchingRows = jdbc.query("""
            SELECT notification_type='ACTION_ITEM_ASSIGNED'
                   AND related_entity_type='ACTION_ITEM_ASSIGNMENT'
                   AND related_entity_id=? AND recipient_user_id=? AND recipient_email=?
              FROM email_deliveries WHERE dedupe_key=?
            """, (rs, row) -> rs.getBoolean(1), eventId, assigneeUserId, recipientEmail, dedupeKey);
        if (matchingRows.size() != 1 || !matchingRows.getFirst()) {
            throw new IllegalStateException("Action item notification event ID was reused with different data");
        }
    }
}
