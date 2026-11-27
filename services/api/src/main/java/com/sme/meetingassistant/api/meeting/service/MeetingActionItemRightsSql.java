package com.sme.meetingassistant.api.meeting.service;

/**
 * Meeting-owned relational authorization for Action Items. Both single-resource
 * admission and set-based Action Item reads use this expression. The caller
 * must first verify the current authenticated active actor. Query aliases
 * meeting and actor must refer to the meeting row and authenticated actor ID.
 */
public final class MeetingActionItemRightsSql {
    private MeetingActionItemRightsSql() {}

    public static final String RIGHTS_JOIN = """
        CROSS JOIN LATERAL (
            SELECT (meeting.organizer_user_id=actor.id OR EXISTS (
                SELECT 1 FROM meeting_participants participant
                 WHERE participant.meeting_id=meeting.id AND participant.user_id=actor.id
                   AND participant.removed_at IS NULL)) AS content_visible,
                (meeting.organizer_user_id=actor.id OR EXISTS (
                SELECT 1 FROM meeting_action_item_scopes scope
                JOIN organizational_units unit ON unit.id=scope.org_unit_id AND unit.status='ACTIVE'
                JOIN manager_scope_units grant_record ON grant_record.org_unit_id=scope.org_unit_id
                JOIN users manager_actor ON manager_actor.id=grant_record.user_id
                    AND manager_actor.account_status='ACTIVE'
                    AND manager_actor.global_role='DEPARTMENT_MANAGER'
                 WHERE scope.meeting_id=meeting.id AND grant_record.user_id=actor.id)) AS manageable
        ) rights
        """;
}
