package com.sme.meetingassistant.api.assistant;

import com.sme.meetingassistant.api.meeting.service.MeetingMediaAccess;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

/** A bounded current-meeting projection independent of knowledge generation state. */
@Component
class AssistantCanonicalContext {
    private final JdbcTemplate jdbc;
    private final MeetingMediaAccess access;
    private final AssistantSourceVerifier sources;

    AssistantCanonicalContext(JdbcTemplate jdbc, MeetingMediaAccess access, AssistantSourceVerifier sources) {
        this.jdbc = jdbc;
        this.access = access;
        this.sources = sources;
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public List<Item> read(UUID meeting, UUID actor, String question) {
        access.requireReadable(meeting, actor);
        return jdbc.query("""
            WITH transcript AS (
              SELECT id, content_revision, status FROM transcripts
              WHERE meeting_id=? AND is_current AND finalized_at IS NOT NULL
                AND status IN ('READY','READY_WITH_WARNINGS')
            ), segments AS (
              SELECT t.id, t.content_revision, t.status, s.id AS segment_id, s.start_ms, s.end_ms,
                  s.ordinal, s.quality_status, s.current_text,
                  ntile(3) OVER (ORDER BY s.ordinal) AS timeline_group,
                  (SELECT count(DISTINCT term) FROM regexp_split_to_table(lower(?), '[[:space:][:punct:]]+') AS term
                   WHERE length(term)>=4 AND strpos(lower(s.current_text), term)>0) AS matches
              FROM transcript t JOIN transcript_segments s ON s.transcript_id=t.id
              WHERE s.current_text ~ '[[:alnum:]]'
            ), excerpts AS (
              SELECT DISTINCT ON (timeline_group) * FROM segments
              ORDER BY timeline_group, matches DESC, ordinal
            ), documents AS (
              (SELECT 0 AS priority, 0 AS ordinal, 'SUMMARY' AS type, id, version_number AS revision,
                 quality_status AS status, CASE WHEN source_type='AI_GENERATED' THEN 'PROVISIONAL_SUMMARY'
                   ELSE 'SECONDARY_APPROVED_SUMMARY' END AS authority,
                 CASE WHEN quality_status='READY' THEN 'ACCEPTED' ELSE 'WARNING' END AS quality,
                 content, null::uuid AS segment_id, null::bigint AS start_ms, null::bigint AS end_ms
               FROM meeting_summary_versions WHERE meeting_id=? AND is_current)
              UNION ALL
              (SELECT 1, 0, 'ACTION_ITEM', id, version, status, 'OFFICIAL_ACTION_ITEM', 'ACCEPTED',
                 concat_ws(E'\\n', title, details, CASE WHEN due_date IS NOT NULL THEN 'Due: ' || due_date END),
                 null, null, null
               FROM action_items WHERE meeting_id=? AND status<>'PROPOSED'
                 AND (source_type='MANUAL' OR confirmed_by_user_id IS NOT NULL)
               ORDER BY updated_at DESC, id LIMIT 2)
              UNION ALL
              (SELECT 2, 0, 'DECISION', id, version, status, 'CONFIRMED_DECISION', 'ACCEPTED',
                 content, null, null, null FROM meeting_decisions
               WHERE meeting_id=? AND status='CONFIRMED' ORDER BY updated_at DESC, id LIMIT 1)
              UNION ALL
              (SELECT 3, ordinal, 'TRANSCRIPT', id, content_revision, status, 'PRIMARY_TRANSCRIPT',
                 CASE WHEN status='READY' AND quality_status='ACCEPTED' THEN 'ACCEPTED' ELSE 'WARNING' END,
                 current_text, segment_id, start_ms, end_ms FROM excerpts)
              UNION ALL
              (SELECT 4, 0, 'MEETING', id, version, status, 'CANONICAL_MEETING', 'ACCEPTED',
                 concat_ws(E'\\n', title, 'Status: ' || status,
                   CASE WHEN started_at IS NOT NULL THEN 'Started (UTC): ' || (started_at AT TIME ZONE 'UTC') END,
                   CASE WHEN ended_at IS NOT NULL THEN 'Ended (UTC): ' || (ended_at AT TIME ZONE 'UTC') END,
                   description), null, null, null
               FROM meetings WHERE id=?)
            )
            SELECT priority, ordinal, type, id, revision, status, authority, quality, segment_id, start_ms,
                   end_ms, left(btrim(content), 900) AS excerpt
            FROM documents WHERE content ~ '[[:alnum:]]' ORDER BY priority, ordinal, id LIMIT 8
            """, (rs, row) -> {
                String type = rs.getString("type");
                UUID source = rs.getObject("id", UUID.class);
                UUID segment = rs.getObject("segment_id", UUID.class);
                var identity = Map.of("sourceType", type, "sourceId", source, "meetingId", meeting);
                long revision = rs.getLong("revision");
                Map<String, Object> reference = new LinkedHashMap<>();
                reference.put("sourceIdentity", identity);
                reference.put("sourceRevision", Map.of("number", revision));
                if (segment != null) {
                    reference.put("segmentId", segment);
                    reference.put("timelineStartMs", rs.getObject("start_ms"));
                    reference.put("timelineEndMs", rs.getObject("end_ms"));
                }
                String content = rs.getString("excerpt");
                // Format/control characters must not make a usable source reject the request.
                String text = content.replaceAll("[\\p{Cf}\\p{Cc}&&[^\\r\\n\\t]]", "").strip();
                return new Item(type, source, revision, Map.of(
                    "reference", reference, "authorityClass", rs.getString("authority"),
                    "qualityClass", rs.getString("quality"), "sourceStatus", rs.getString("status"), "text", text
                ));
            }, meeting, question, meeting, meeting, meeting, meeting).stream()
            .filter(item -> !((String) item.payload().get("text")).isBlank())
            .filter(item -> sources.current(item.type(), item.id(), meeting, item.revision()))
            .toList();
    }

    record Item(String type, UUID id, long revision, Map<String, Object> payload) {}
}
