package com.sme.meetingassistant.api.transcript.service;

import com.sme.meetingassistant.api.meeting.service.MeetingMediaAccess;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Compact current transcript reference/coverage read. Source owner remains
 * Transcript; Minutes cannot import the mutable transcript persistence layer.
 */
@Service
public class SqlTranscriptMinutesReader implements TranscriptMinutesSource {
    private final JdbcTemplate jdbc;
    private final MeetingMediaAccess access;
    private final AuthenticatedUserId principal;

    public SqlTranscriptMinutesReader(JdbcTemplate jdbc, MeetingMediaAccess access,
            AuthenticatedUserId principal) {
        this.jdbc = jdbc;
        this.access = access;
        this.principal = principal;
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<Reference> currentReference(UUID meetingId) {
        access.requireReadable(meetingId, principal.requireUserId());
        return jdbc.query("""
            SELECT t.id, t.processing_job_id, t.version_number, t.language_code,
                   t.status, t.content_revision, t.duration_ms,
                   (SELECT count(*) FROM transcript_segments s
                     WHERE s.transcript_id=t.id
                       AND s.quality_status='SUSPICIOUS') AS suspicious_segments,
                   (SELECT count(*) FROM transcript_segments s
                     WHERE s.transcript_id=t.id
                       AND s.quality_status='UNRESOLVED') AS unresolved_segments,
                   (SELECT count(*) FROM transcript_coverage_regions c
                     WHERE c.transcript_id=t.id
                       AND (c.coverage_status <> 'COVERED' OR c.recovered=FALSE
                            AND c.coverage_status <> 'COVERED')) AS unresolved_coverage
              FROM transcripts t WHERE t.meeting_id=? AND t.is_current
            """, (rs, ignored) -> new Reference(
                    rs.getObject("id", UUID.class),
                    rs.getObject("processing_job_id", UUID.class),
                    rs.getInt("version_number"),
                    rs.getString("language_code"),
                    rs.getString("status"),
                    rs.getLong("content_revision"),
                    rs.getObject("duration_ms", Long.class),
                    rs.getLong("suspicious_segments"),
                    rs.getLong("unresolved_segments"),
                    rs.getLong("unresolved_coverage")), meetingId).stream().findFirst();
    }
}
