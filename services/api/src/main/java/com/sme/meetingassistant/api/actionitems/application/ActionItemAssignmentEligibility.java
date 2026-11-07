package com.sme.meetingassistant.api.actionitems.application;

import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Canonical read-only Action Items policy. Notification never owns or infers
 * the current assignment lifecycle, even for A -> B -> A reassignment.
 */
@Service
public class ActionItemAssignmentEligibility {
    private final JdbcTemplate jdbc;

    public ActionItemAssignmentEligibility(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Transactional(readOnly = true)
    public boolean isCurrentOfficialAssignment(UUID eventId, UUID assigneeUserId) {
        if (eventId == null || assigneeUserId == null) return false;
        return Boolean.TRUE.equals(jdbc.queryForObject("""
            SELECT EXISTS (
                SELECT 1
                  FROM action_item_assignment_events event
                  JOIN action_items item ON item.id=event.action_item_id
                 WHERE event.id=? AND event.assignee_user_id=?
                   AND item.assignee_user_id=event.assignee_user_id
                   AND item.version >= event.action_item_version
                   AND item.status IN ('OPEN','IN_PROGRESS')
                   AND (item.source_type='MANUAL'
                        OR item.confirmed_by_user_id IS NOT NULL)
                   AND NOT EXISTS (
                       SELECT 1 FROM action_item_assignment_events newer
                        WHERE newer.action_item_id=event.action_item_id
                          AND newer.action_item_version>event.action_item_version
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM action_item_assignment_revocations revoked
                        WHERE revoked.event_id=event.id
                   )
            )
            """, Boolean.class, eventId, assigneeUserId));
    }
}
