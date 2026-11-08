package com.sme.meetingassistant.api.actionitems.application;

import com.sme.meetingassistant.api.meeting.service.MeetingActionItemAccess;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Objects;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * SQL-scoped official Action Item aggregation using the same visible relations
 * as ActionItemService.list, not loading all items and counting in Java.
 * A non-member assignee may read their official item without getting meeting
 * transcript/summary permissions. An AI proposal assignee hint grants nothing.
 */
@Service
@Transactional(readOnly = true)
public class SqlActionItemReportingAdapter implements ActionItemReportingPort {
    private static final String OFFICIAL = """
        FROM action_items ai
        JOIN meetings meeting ON meeting.id = ai.meeting_id
        WHERE (ai.source_type='MANUAL' OR ai.confirmed_by_user_id IS NOT NULL)
        """;

    private static final String VISIBLE = """
        AND (
            meeting.organizer_user_id = ?
            OR EXISTS (
                SELECT 1 FROM meeting_participants participant
                 WHERE participant.meeting_id=ai.meeting_id
                   AND participant.user_id=?
                   AND participant.removed_at IS NULL)
            OR ai.assignee_user_id=?
            OR EXISTS (
                SELECT 1 FROM meeting_action_item_scopes scope
                JOIN organizational_units unit ON unit.id=scope.org_unit_id
                   AND unit.status='ACTIVE'
                JOIN manager_scope_units grant_record
                   ON grant_record.org_unit_id=scope.org_unit_id
                JOIN users manager_actor ON manager_actor.id=grant_record.user_id
                   AND manager_actor.account_status='ACTIVE'
                   AND manager_actor.global_role='DEPARTMENT_MANAGER'
                WHERE scope.meeting_id=ai.meeting_id
                  AND grant_record.user_id=?)
        )
        """;

    private static final String SELECT_COUNTS = """
        SELECT COUNT(*) FILTER (WHERE ai.status='OPEN') AS open_count,
               COUNT(*) FILTER (WHERE ai.status='IN_PROGRESS') AS in_progress_count,
               COUNT(*) FILTER (WHERE ai.status='DONE') AS done_count,
               COUNT(*) FILTER (WHERE ai.status='CANCELLED') AS cancelled_count,
               COUNT(*) FILTER (
                   WHERE ai.status IN ('OPEN','IN_PROGRESS')
                     AND ai.due_date < ?) AS overdue_count
        """;

    private final JdbcTemplate jdbc;
    private final MeetingActionItemAccess meetingAccess;
    private final ZoneId businessZone;

    public SqlActionItemReportingAdapter(JdbcTemplate jdbc,
            MeetingActionItemAccess meetingAccess,
            @Value("${app.action-items.business-zone:UTC}") String businessZoneId) {
        this.jdbc = jdbc;
        this.meetingAccess = meetingAccess;
        this.businessZone = ZoneId.of(businessZoneId);
    }

    @Override
    public OfficialCounts assignedOfficial(UUID actorId, Instant asOf) {
        requireActor(actorId);
        LocalDate today = businessDate(asOf);
        return jdbc.queryForObject(SELECT_COUNTS + OFFICIAL
                + " AND ai.assignee_user_id=?", (rs, ignored) -> counts(rs),
                today, actorId);
    }

    @Override
    public OfficialCounts visibleOfficial(UUID actorId, Instant asOf) {
        requireActor(actorId);
        LocalDate today = businessDate(asOf);
        return jdbc.queryForObject(SELECT_COUNTS + OFFICIAL + VISIBLE,
                (rs, ignored) -> counts(rs),
                today, actorId, actorId, actorId, actorId);
    }

    private void requireActor(UUID actorId) {
        meetingAccess.requireCurrentActiveActor(Objects.requireNonNull(actorId, "actorId"));
    }

    private LocalDate businessDate(Instant asOf) {
        return Objects.requireNonNull(asOf, "asOf").atZone(businessZone).toLocalDate();
    }

    private static OfficialCounts counts(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new OfficialCounts(rs.getLong("open_count"), rs.getLong("in_progress_count"),
                rs.getLong("done_count"), rs.getLong("cancelled_count"),
                rs.getLong("overdue_count"));
    }
}
