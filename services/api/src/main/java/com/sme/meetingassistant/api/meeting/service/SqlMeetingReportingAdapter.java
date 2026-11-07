package com.sme.meetingassistant.api.meeting.service;

import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Collections;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * SQL-scoped read model. The authorization predicate intentionally mirrors the
 * Meeting-owned current organizer / non-removed participant policy, rather than
 * using department-directory powers or filtering after querying.
 */
@Service
@Transactional(readOnly = true)
public class SqlMeetingReportingAdapter implements MeetingReportingPort {
    private static final int MAX_ROWS = 100;

    private static final String VISIBLE = """
        FROM meetings m
        WHERE (m.organizer_user_id = ? OR EXISTS (
            SELECT 1 FROM meeting_participants mp
             WHERE mp.meeting_id = m.id
               AND mp.user_id = ?
               AND mp.removed_at IS NULL))
        """;

    private static final RowMapper<MeetingRow> ROW = SqlMeetingReportingAdapter::row;

    private final JdbcTemplate jdbc;
    private final MeetingActionItemAccess meetingAccess;

    public SqlMeetingReportingAdapter(JdbcTemplate jdbc, MeetingActionItemAccess meetingAccess) {
        this.jdbc = jdbc;
        this.meetingAccess = meetingAccess;
    }

    @Override
    public Map<MeetingStatus, Long> countVisibleByStatus(UUID actorId) {
        checkActor(actorId);
        EnumMap<MeetingStatus, Long> counts = new EnumMap<>(MeetingStatus.class);
        for (MeetingStatus status : MeetingStatus.values()) counts.put(status, 0L);
        jdbc.query("SELECT m.status, COUNT(*) AS total " + VISIBLE + " GROUP BY m.status",
                (RowCallbackHandler) rs -> counts.put(MeetingStatus.valueOf(rs.getString("status")),
                        rs.getLong("total")), actorId, actorId);
        return Collections.unmodifiableMap(counts);
    }

    @Override
    public List<MeetingRow> scheduledStartingIn(UUID actorId, Instant fromInclusive,
            Instant toExclusive, int limit) {
        checkActor(actorId);
        checkWindow(fromInclusive, toExclusive, limit);
        return jdbc.query("""
                SELECT m.id, m.title, m.status, m.scheduled_start_at,
                       m.scheduled_end_at, m.ended_at
                """ + VISIBLE + """
                AND m.status = 'SCHEDULED'
                AND m.scheduled_start_at >= ? AND m.scheduled_start_at < ?
                ORDER BY m.scheduled_start_at ASC, m.id ASC LIMIT ?
                """, ROW, actorId, actorId, utc(fromInclusive), utc(toExclusive), limit);
    }

    @Override
    public List<MeetingRow> endedIn(UUID actorId, Instant fromInclusive,
            Instant toExclusive, int limit) {
        checkActor(actorId);
        checkWindow(fromInclusive, toExclusive, limit);
        return jdbc.query("""
                SELECT m.id, m.title, m.status, m.scheduled_start_at,
                       m.scheduled_end_at, m.ended_at
                """ + VISIBLE + """
                AND m.status = 'ENDED'
                AND m.ended_at >= ? AND m.ended_at < ?
                ORDER BY m.ended_at DESC, m.id DESC LIMIT ?
                """, ROW, actorId, actorId, utc(fromInclusive), utc(toExclusive), limit);
    }

    private void checkActor(UUID actorId) {
        meetingAccess.requireCurrentActiveActor(Objects.requireNonNull(actorId, "actorId"));
    }

    private static void checkWindow(Instant from, Instant to, int limit) {
        Objects.requireNonNull(from, "fromInclusive");
        Objects.requireNonNull(to, "toExclusive");
        if (!from.isBefore(to) || limit < 1 || limit > MAX_ROWS) {
            throw new IllegalArgumentException("Invalid reporting interval or row limit");
        }
    }

    private static OffsetDateTime utc(Instant instant) {
        return instant.atOffset(ZoneOffset.UTC);
    }

    private static MeetingRow row(ResultSet rs, int ignored) throws SQLException {
        return new MeetingRow(rs.getObject("id", UUID.class), rs.getString("title"),
                MeetingStatus.valueOf(rs.getString("status")),
                rs.getObject("scheduled_start_at", OffsetDateTime.class),
                rs.getObject("scheduled_end_at", OffsetDateTime.class),
                rs.getObject("ended_at", OffsetDateTime.class));
    }
}
