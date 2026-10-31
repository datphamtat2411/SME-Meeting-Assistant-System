package com.sme.meetingassistant.api.meetingintelligence.repository;

import com.sme.meetingassistant.api.meetingintelligence.dto.SummaryView;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Owns Summary version persistence only. Locks the parent meeting for every
 * current-version change, consistent with Transcript Review's lock order.
 */
@Repository
public class SummaryRepository {
    private final JdbcTemplate jdbc;

    public SummaryRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public Optional<SummaryView> current(UUID meetingId) {
        List<SummaryView> rows = this.jdbc.query("""
            SELECT s.id, s.meeting_id, s.version_number, s.content, s.source_type,
                   s.quality_status, s.processing_job_id, s.transcript_id,
                   s.content_revision, s.created_at, s.created_by_user_id,
                   current_source.id AS current_transcript_id,
                   current_source.content_revision AS current_source_revision
            FROM meeting_summary_versions s
            LEFT JOIN transcripts current_source
              ON current_source.meeting_id=s.meeting_id AND current_source.is_current
            WHERE s.meeting_id=? AND s.is_current
            """, (rs, row) -> {
                UUID source = rs.getObject("transcript_id", UUID.class);
                UUID currentSource = rs.getObject("current_transcript_id", UUID.class);
                boolean stale = currentSource == null || !currentSource.equals(source)
                    || rs.getLong("current_source_revision") != rs.getLong("content_revision");
                return new SummaryView(
                    rs.getObject("id", UUID.class), rs.getObject("meeting_id", UUID.class),
                    rs.getInt("version_number"), rs.getString("content"),
                    rs.getString("source_type"), rs.getString("quality_status"),
                    rs.getObject("processing_job_id", UUID.class), source,
                    rs.getLong("content_revision"), stale,
                    rs.getObject("created_at", OffsetDateTime.class),
                    rs.getObject("created_by_user_id", UUID.class));
            }, meetingId);
        return rows.stream().findFirst();
    }

    /** Serializes edits and new AI-version publication by meeting, not globally. */
    public void lockMeeting(UUID meetingId) {
        this.jdbc.query("SELECT id FROM meetings WHERE id=? FOR UPDATE", rs -> {}, meetingId);
    }

    public int nextVersion(UUID meetingId) {
        return this.jdbc.queryForObject("""
            SELECT COALESCE(MAX(version_number), 0) + 1
              FROM meeting_summary_versions WHERE meeting_id=?
            """, Integer.class, meetingId);
    }

    public void replaceCurrentWithHumanEdit(UUID meetingId, SummaryView previous,
            UUID newId, UUID actorId, String content) {
        int changed = this.jdbc.update("""
            UPDATE meeting_summary_versions SET is_current=FALSE
             WHERE id=? AND meeting_id=? AND is_current
            """, previous.id(), meetingId);
        if (changed != 1) {
            throw new IllegalStateException("Current Summary changed during protected transaction.");
        }
        this.jdbc.update("""
            INSERT INTO meeting_summary_versions(
                id,meeting_id,version_number,content,source_type,
                based_on_summary_version_id,created_by_user_id,
                transcript_id,content_revision,quality_status,is_current)
            VALUES (?,?,?,?,'HUMAN_EDIT',?,?,?,?,?,TRUE)
            """, newId, meetingId, nextVersion(meetingId), content,
            previous.id(), actorId, previous.transcriptId(), previous.contentRevision(),
            previous.qualityStatus());
    }
}
