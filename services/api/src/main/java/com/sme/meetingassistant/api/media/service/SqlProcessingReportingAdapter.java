package com.sme.meetingassistant.api.media.service;

import com.sme.meetingassistant.api.meeting.service.MeetingActionItemAccess;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Exact current organizer/participant Meeting-content authorization in SQL. */
@Service
@Transactional(readOnly = true)
public class SqlProcessingReportingAdapter implements ProcessingReportingPort {
    private final JdbcTemplate jdbc;
    private final MeetingActionItemAccess meetingAccess;

    public SqlProcessingReportingAdapter(JdbcTemplate jdbc,
            MeetingActionItemAccess meetingAccess) {
        this.jdbc = jdbc;
        this.meetingAccess = meetingAccess;
    }

    @Override
    public Map<String, Long> visibleJobStatusCounts(UUID actorId) {
        meetingAccess.requireCurrentActiveActor(Objects.requireNonNull(actorId, "actorId"));
        Map<String, Long> counts = new LinkedHashMap<>();
        jdbc.query("""
            SELECT job.status, count(*) AS total
              FROM processing_jobs job
              JOIN meetings m ON m.id=job.meeting_id
             WHERE m.organizer_user_id=?
                OR EXISTS (
                    SELECT 1 FROM meeting_participants mp
                     WHERE mp.meeting_id=job.meeting_id
                       AND mp.user_id=? AND mp.removed_at IS NULL)
             GROUP BY job.status
             ORDER BY job.status
            """, (RowCallbackHandler) rs -> counts.put(rs.getString("status"), rs.getLong("total")),
                actorId, actorId);
        return Map.copyOf(counts);
    }
}
