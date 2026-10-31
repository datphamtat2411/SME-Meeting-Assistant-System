package com.sme.meetingassistant.api.meetingintelligence.repository;

import com.sme.meetingassistant.api.meetingintelligence.dto.DecisionView;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.PageRequest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Canonical Decision data only. Mutations must be called inside a transaction
 * holding the parent Meeting lock. Transcript evidence is validated by the
 * Transcript-owned application port before inserting any evidence rows.
 */
@Repository
public class DecisionRepository {
    private static final String SELECT = """
        SELECT d.id, d.meeting_id, d.content, d.status, d.source_type,
               d.transcript_id, d.content_revision, d.version, d.created_at,
               d.created_by_user_id, d.confirmed_at, d.confirmed_by_user_id,
               d.rejected_at, d.rejected_by_user_id,
               current_source.id AS current_transcript_id,
               current_source.content_revision AS current_source_revision
        FROM meeting_decisions d
        LEFT JOIN transcripts current_source
          ON current_source.meeting_id=d.meeting_id AND current_source.is_current
        """;

    private final JdbcTemplate jdbc;

    public DecisionRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Reuse the meeting lock convention already used for Summary/Transcript. */
    public void lockMeeting(UUID meetingId) {
        jdbc.query("SELECT id FROM meetings WHERE id=? FOR UPDATE", rs -> {}, meetingId);
    }

    public Page<DecisionView> page(UUID meetingId, String status, int page, int size) {
        String filter = status == null ? "" : " AND d.status=?";
        List<Object> args = new ArrayList<>();
        args.add(meetingId);
        if (status != null) args.add(status);
        args.add(size);
        args.add((long) page * size);
        List<State> rows = jdbc.query(SELECT
            + " WHERE d.meeting_id=?" + filter
            + " ORDER BY d.created_at DESC,d.id DESC LIMIT ? OFFSET ?",
            (rs, n) -> state(rs), args.toArray());

        Long total = status == null
            ? jdbc.queryForObject("SELECT count(*) FROM meeting_decisions WHERE meeting_id=?",
                Long.class, meetingId)
            : jdbc.queryForObject("SELECT count(*) FROM meeting_decisions WHERE meeting_id=? AND status=?",
                Long.class, meetingId, status);
        return new PageImpl<>(toViews(rows), PageRequest.of(page, size), total == null ? 0 : total);
    }

    /** Lookup is always scoped to its parent meeting to avoid UUID-based disclosure. */
    public Optional<DecisionView> find(UUID meetingId, UUID decisionId) {
        List<State> rows = jdbc.query(SELECT + " WHERE d.meeting_id=? AND d.id=?",
            (rs, n) -> state(rs), meetingId, decisionId);
        return toViews(rows).stream().findFirst();
    }

    public void createConfirmed(UUID id, UUID meetingId, UUID actorId, String content,
            UUID transcriptId, Long contentRevision, List<UUID> evidence) {
        jdbc.update("""
            INSERT INTO meeting_decisions (
                id,meeting_id,content,status,source_type,transcript_id,content_revision,
                created_by_user_id,confirmed_by_user_id,confirmed_at)
            VALUES (?,?,?,'CONFIRMED','MANUAL',?,?,?, ?,CURRENT_TIMESTAMP)
            """, id, meetingId, content, transcriptId, contentRevision, actorId, actorId);
        for (UUID segment : evidence) {
            jdbc.update("""
                INSERT INTO decision_evidence(decision_id,transcript_id,transcript_segment_id)
                VALUES (?,?,?)
                """, id, transcriptId, segment);
        }
    }

    /**
     * Atomic content update, optimistic version check, and attributed history.
     * The surrounding service transaction rolls back both writes on failure.
     */
    public boolean updateConfirmedContent(UUID meetingId, DecisionView previous, String content,
            UUID actorId) {
        int updated = jdbc.update("""
            UPDATE meeting_decisions
               SET content=?,version=version+1,updated_at=CURRENT_TIMESTAMP
             WHERE id=? AND meeting_id=? AND status='CONFIRMED' AND version=?
            """, content, previous.id(), meetingId, previous.version());
        if (updated != 1) return false;
        Integer nextRevision = jdbc.queryForObject("""
            SELECT COALESCE(MAX(revision_number),0)+1
              FROM decision_revisions WHERE decision_id=?
            """, Integer.class, previous.id());
        jdbc.update("""
            INSERT INTO decision_revisions(
                id,decision_id,revision_number,previous_content,new_content,edited_by_user_id)
            VALUES (?,?,?,?,?,?)
            """, UUID.randomUUID(), previous.id(), nextRevision, previous.content(), content, actorId);
        return true;
    }

    /**
     * Perform the one authoritative state transition under the caller's
     * meeting-row lock. The version predicate is a second concurrency fence.
     * Confirmation and rejection actors/times are always server assigned.
     */
    public boolean reviewProposal(UUID meetingId, UUID decisionId, long expectedVersion,
            UUID reviewerId, boolean confirm) {
        String assignment = confirm
            ? "status='CONFIRMED',confirmed_by_user_id=?,confirmed_at=CURRENT_TIMESTAMP"
            : "status='REJECTED',rejected_by_user_id=?,rejected_at=CURRENT_TIMESTAMP";
        int updated = jdbc.update("""
            UPDATE meeting_decisions SET %s,version=version+1,updated_at=CURRENT_TIMESTAMP
             WHERE meeting_id=? AND id=? AND status='PROPOSED' AND version=?
            """.formatted(assignment), reviewerId, meetingId, decisionId, expectedVersion);
        return updated == 1;
    }

    private static State state(ResultSet rs) throws SQLException {
        UUID source = rs.getObject("transcript_id", UUID.class);
        UUID current = rs.getObject("current_transcript_id", UUID.class);
        Long revision = nullableRevision(rs, "content_revision");
        boolean stale = source != null && (current == null || !source.equals(current)
            || !revision.equals(nullableRevision(rs, "current_source_revision")));
        return new State(
            rs.getObject("id", UUID.class), rs.getObject("meeting_id", UUID.class),
            rs.getString("content"), rs.getString("status"), rs.getString("source_type"),
            source, revision, stale, rs.getLong("version"),
            rs.getObject("created_at", OffsetDateTime.class),
            rs.getObject("created_by_user_id", UUID.class),
            rs.getObject("confirmed_at", OffsetDateTime.class),
            rs.getObject("confirmed_by_user_id", UUID.class),
            rs.getObject("rejected_at", OffsetDateTime.class),
            rs.getObject("rejected_by_user_id", UUID.class));
    }

    private static Long nullableRevision(ResultSet rs, String name) throws SQLException {
        long value = rs.getLong(name);
        return rs.wasNull() ? null : value;
    }

    /** Fetch evidence for a full page in one query, never N+1 reads. */
    private List<DecisionView> toViews(List<State> states) {
        if (states.isEmpty()) return List.of();
        String placeholders = String.join(",", Collections.nCopies(states.size(), "?"));
        Map<UUID, List<UUID>> evidence = new HashMap<>();
        jdbc.query("""
            SELECT decision_id,transcript_segment_id FROM decision_evidence
            WHERE decision_id IN (%s) ORDER BY decision_id,created_at,transcript_segment_id
            """.formatted(placeholders), rs -> {
                UUID id = rs.getObject("decision_id", UUID.class);
                evidence.computeIfAbsent(id, k -> new ArrayList<>())
                    .add(rs.getObject("transcript_segment_id", UUID.class));
            }, states.stream().map(State::id).toArray());
        return states.stream().map(s -> new DecisionView(
            s.id(), s.meetingId(), s.content(), s.status(), s.sourceType(),
            evidence.getOrDefault(s.id(), List.of()), s.transcriptId(), s.contentRevision(),
            s.stale(), s.version(), s.createdAt(), s.createdBy(),
            s.confirmedAt(), s.confirmedBy(), s.rejectedAt(), s.rejectedBy())).toList();
    }

    private record State(
        UUID id, UUID meetingId, String content, String status, String sourceType,
        UUID transcriptId, Long contentRevision, boolean stale, long version,
        OffsetDateTime createdAt, UUID createdBy,
        OffsetDateTime confirmedAt, UUID confirmedBy,
        OffsetDateTime rejectedAt, UUID rejectedBy) {}
}
