package com.sme.meetingassistant.api.actionitems.application;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Objects;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Fail-closed aggregation over official Action Items attached to a Meeting's
 * immutable ACTION-ITEM classification from V30, and a CURRENT manager grant.
 *
 * This recorded Action Item scope must NOT be reused as a meeting-content
 * permission or as an assumption about every meeting in the organization.
 */
@Service
@Transactional(readOnly = true)
public class SqlManagedActionItemReportingAdapter implements ManagedActionItemReportingPort {
    private static final Duration MAX_PERIOD = Duration.ofDays(366);
    private static final String COUNTS = """
        SELECT COUNT(*) FILTER (WHERE ai.status='OPEN') AS open_count,
               COUNT(*) FILTER (WHERE ai.status='IN_PROGRESS') AS in_progress_count,
               COUNT(*) FILTER (WHERE ai.status='DONE') AS done_count,
               COUNT(*) FILTER (WHERE ai.status='CANCELLED') AS cancelled_count,
               COUNT(*) FILTER (
                   WHERE ai.status IN ('OPEN','IN_PROGRESS') AND ai.due_date < ?
               ) AS overdue_count,
               COUNT(*) AS official_count
          FROM manager_scope_units grant_record
          JOIN users manager_actor
            ON manager_actor.id=grant_record.user_id
           AND manager_actor.account_status='ACTIVE'
           AND manager_actor.global_role='DEPARTMENT_MANAGER'
          JOIN organizational_units unit
            ON unit.id=grant_record.org_unit_id AND unit.status='ACTIVE'
          JOIN meeting_action_item_scopes recorded_scope
            ON recorded_scope.org_unit_id=grant_record.org_unit_id
          JOIN action_items ai
            ON ai.meeting_id=recorded_scope.meeting_id
         WHERE grant_record.user_id=?
           AND (ai.source_type='MANUAL' OR ai.confirmed_by_user_id IS NOT NULL)
           AND ai.created_at >= ?
           AND ai.created_at < ?
        """;

    private final JdbcTemplate jdbc;
    private final ZoneId businessZone;

    public SqlManagedActionItemReportingAdapter(JdbcTemplate jdbc,
            @Value("${app.action-items.business-zone:UTC}") String businessZoneId) {
        this.jdbc = jdbc;
        this.businessZone = ZoneId.of(businessZoneId);
    }

    @Override
    public OfficialCohort countOfficialCreatedIn(UUID managerId, UUID unitId,
            Instant fromInclusive, Instant toExclusive, Instant asOf) {
        Objects.requireNonNull(managerId, "managerId");
        Objects.requireNonNull(fromInclusive, "fromInclusive");
        Objects.requireNonNull(toExclusive, "toExclusive");
        Objects.requireNonNull(asOf, "asOf");
        if (!fromInclusive.isBefore(toExclusive)
                || Duration.between(fromInclusive, toExclusive).compareTo(MAX_PERIOD) > 0) {
            throw new IllegalArgumentException("Invalid management reporting interval");
        }
        LocalDate today = asOf.atZone(businessZone).toLocalDate();
        // Only the final literal SQL clause is selected; no user value is
        // concatenated into a statement. The unit/grant predicate stays in SQL.
        String sql = COUNTS + (unitId == null ? "" : " AND recorded_scope.org_unit_id=?");
        return jdbc.queryForObject(sql, (rs, ignored) -> new OfficialCohort(
                rs.getLong("open_count"),
                rs.getLong("in_progress_count"),
                rs.getLong("done_count"),
                rs.getLong("cancelled_count"),
                rs.getLong("overdue_count"),
                rs.getLong("official_count")),
                unitId == null
                    ? new Object[]{today, managerId, utc(fromInclusive), utc(toExclusive)}
                    : new Object[]{today, managerId, utc(fromInclusive), utc(toExclusive), unitId});
    }

    private static OffsetDateTime utc(Instant instant) {
        return instant.atOffset(ZoneOffset.UTC);
    }
}
