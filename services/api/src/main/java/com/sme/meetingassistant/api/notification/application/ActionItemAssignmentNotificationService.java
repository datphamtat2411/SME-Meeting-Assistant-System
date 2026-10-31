package com.sme.meetingassistant.api.notification.application;

import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** Persists assignment email intent atomically with the authoritative Action Items transaction. */
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
        String dedupeKey = "action-item-assignment:" + eventId;
        boolean enabled = preferences.actionItemEmailEnabled(assigneeUserId);
        int inserted = jdbc.update("""
            INSERT INTO email_deliveries(id,notification_type,recipient_user_id,recipient_email,
                related_entity_type,related_entity_id,status,skip_reason,dedupe_key,
                attempt_count,created_at,updated_at)
            VALUES (?,'ACTION_ITEM_ASSIGNED',?,?,'ACTION_ITEM',?,?,?, ?,0,
                clock_timestamp(),clock_timestamp())
            ON CONFLICT (dedupe_key) DO NOTHING
            """, UUID.randomUUID(), assigneeUserId, recipientEmail, actionItemId,
            enabled ? "PENDING" : "SKIPPED", enabled ? null : "USER_PREFERENCE_DISABLED", dedupeKey);
        if (inserted == 0) validateReplay(dedupeKey, actionItemId, assigneeUserId, recipientEmail);
    }

    private void validateReplay(String dedupeKey, UUID actionItemId, UUID assigneeUserId,
            String recipientEmail) {
        List<Boolean> matchingRows = jdbc.query("""
            SELECT notification_type='ACTION_ITEM_ASSIGNED'
                   AND related_entity_type='ACTION_ITEM'
                   AND related_entity_id=? AND recipient_user_id=? AND recipient_email=?
              FROM email_deliveries WHERE dedupe_key=?
            """, (rs, row) -> rs.getBoolean(1), actionItemId, assigneeUserId, recipientEmail, dedupeKey);
        if (matchingRows.size() != 1 || !matchingRows.getFirst()) {
            throw new IllegalStateException("Action item notification event ID was reused with different data");
        }
    }
}
