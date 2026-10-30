package com.sme.meetingassistant.api.transcript.repository;

import com.sme.meetingassistant.api.transcript.dto.TranscriptViews.CorrectionView;
import com.sme.meetingassistant.api.transcript.dto.TranscriptViews.CoverageView;
import com.sme.meetingassistant.api.transcript.dto.TranscriptViews.SegmentView;
import com.sme.meetingassistant.api.transcript.dto.TranscriptViews.SpeakerView;
import com.sme.meetingassistant.api.transcript.dto.TranscriptViews.TranscriptView;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.CoverageResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.SegmentResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.SpeakerResult;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.TranscriptResult;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.TreeMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;

@Repository
public class TranscriptRepository {
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public TranscriptRepository(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    @Transactional
    public void publish(TranscriptResult result) {
        // Validate before locking so malformed AI results never become accepted replays.
        validate(result);
        String fingerprint = publicationDigest(result);
        // The meeting lock serializes version numbering and replay detection across API instances.
        this.jdbc.query("SELECT id FROM meetings WHERE id=? FOR UPDATE",
            (rs, row) -> rs.getObject(1, UUID.class), result.meetingId()).stream().findFirst()
            .orElseThrow(TranscriptRepository::notFound);

        List<Publication> prior = this.jdbc.query("""
            SELECT id, publication_sha256 FROM transcripts WHERE processing_job_id=?
            """, (rs, row) -> new Publication(rs.getObject("id", UUID.class),
                rs.getString("publication_sha256")), result.processingJobId());
        if (!prior.isEmpty()) {
            if (prior.size() == 1 && fingerprint.equals(prior.getFirst().digest())) {
                // Preserve the current transcript version and any human corrections.
                return;
            }
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "The processing job already published a different transcript result.");
        }

        Integer eligible = this.jdbc.queryForObject("""
            SELECT count(*) FROM processing_jobs j JOIN meeting_media m
              ON m.meeting_id=j.meeting_id AND m.id=j.source_media_id
            JOIN processing_stage_runs sr ON sr.processing_job_id=j.id
              AND sr.id=? AND sr.stage_code='FINALIZING_TRANSCRIPT'
              AND sr.status IN ('SUCCEEDED','SUCCEEDED_WITH_WARNING')
              AND sr.attempt_number = (
                SELECT MAX(x.attempt_number) FROM processing_stage_runs x
                WHERE x.processing_job_id=j.id AND x.stage_code=sr.stage_code)
            WHERE j.id=? AND j.meeting_id=? AND j.source_media_id=?
              AND j.status IN ('COMPLETED','COMPLETED_WITH_WARNINGS') AND m.status='AVAILABLE'
            """, Integer.class, result.sourceStageRunId(), result.processingJobId(),
            result.meetingId(), result.sourceMediaId());
        if (eligible == null || eligible != 1) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "Transcript source or finalization attempt is not eligible.");
        }
        int version = this.jdbc.queryForObject(
            "SELECT COALESCE(MAX(version_number),0)+1 FROM transcripts WHERE meeting_id=?",
            Integer.class, result.meetingId());
        this.jdbc.update("UPDATE transcripts SET is_current=FALSE WHERE meeting_id=? AND is_current",
            result.meetingId());
        UUID transcriptId = UUID.randomUUID();
        this.jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,source_stage_run_id,
              version_number,language_code,status,is_current,duration_ms,finalized_at,publication_sha256)
            VALUES (?,?,?,?,?,?,?,?,TRUE,?,CURRENT_TIMESTAMP,?)
            """, transcriptId, result.meetingId(), result.sourceMediaId(), result.processingJobId(),
            result.sourceStageRunId(), version, result.languageCode(), result.status().name(),
            result.durationMs(), fingerprint);

        Map<String, UUID> clusters = new LinkedHashMap<>();
        for (SpeakerResult speaker : result.speakers()) {
            UUID clusterId = UUID.randomUUID();
            this.jdbc.update("INSERT INTO speaker_clusters(id,transcript_id,label) VALUES (?,?,?)",
                clusterId, transcriptId, speaker.label().trim());
            clusters.put(speaker.label(), clusterId);
        }
        for (SegmentResult segment : result.segments()) {
            UUID clusterId = segment.speakerLabel() == null ? null : clusters.get(segment.speakerLabel());
            this.jdbc.update("""
                INSERT INTO transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,current_text,
                  quality_status,speaker_cluster_id,source_stage_run_id,confidence_metadata)
                VALUES (?,?,?,?,?,?,?,?,?,CAST(? AS jsonb))
                """, UUID.randomUUID(), transcriptId, segment.ordinal(), segment.startMs(), segment.endMs(),
                segment.text(), segment.qualityStatus(), clusterId, segment.sourceStageRunId(),
                encode(segment.confidenceMetadata()));
        }
        for (CoverageResult region : result.coverage()) {
            this.jdbc.update("""
                INSERT INTO transcript_coverage_regions(id,transcript_id,start_ms,end_ms,coverage_status,
                  recovered,retry_count,metadata)
                VALUES (?,?,?,?,?,?,?,CAST(? AS jsonb))
                """, UUID.randomUUID(), transcriptId, region.startMs(), region.endMs(), region.coverageStatus(),
                region.recovered(), region.retryCount(), encode(region.metadata()));
        }
    }

    /**
     * Hash the complete immutable AI result, not mutable transcript_segments.current_text.
     * Canonical map ordering makes metadata-key ordering immaterial to exact retries.
     */
    private String publicationDigest(TranscriptResult result) {
        try {
            TranscriptResult canonical = new TranscriptResult(result.meetingId(), result.sourceMediaId(),
                result.processingJobId(), result.sourceStageRunId(), result.languageCode(),
                result.durationMs(), result.status(),
                result.segments().stream().map(s -> new SegmentResult(s.ordinal(), s.startMs(),
                    s.endMs(), s.text(), s.qualityStatus(), s.speakerLabel(), s.sourceStageRunId(),
                    sortedMetadata(s.confidenceMetadata()))).toList(),
                result.coverage().stream().map(c -> new CoverageResult(c.startMs(), c.endMs(),
                    c.coverageStatus(), c.recovered(), c.retryCount(), sortedMetadata(c.metadata()))).toList(),
                result.speakers());
            byte[] bytes = this.json.writeValueAsString(canonical).getBytes(StandardCharsets.UTF_8);
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (JacksonException | NoSuchAlgorithmException exception) {
            throw new IllegalStateException("Could not fingerprint transcript publication.", exception);
        }
    }

    private static Map<String, Object> sortedMetadata(Map<String, Object> metadata) {
        if (metadata == null) return null;
        Map<String, Object> sorted = new TreeMap<>();
        metadata.forEach((key, value) -> sorted.put(key, canonicalMetadata(value)));
        return sorted;
    }

    private static Object canonicalMetadata(Object value) {
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> sorted = new TreeMap<>();
            map.forEach((key, item) -> sorted.put(String.valueOf(key), canonicalMetadata(item)));
            return sorted;
        }
        if (value instanceof List<?> list) return list.stream().map(TranscriptRepository::canonicalMetadata).toList();
        return value;
    }

    private static void validate(TranscriptResult r) {
        if (r == null || r.meetingId() == null || r.sourceMediaId() == null || r.processingJobId() == null
                || r.languageCode() == null || r.languageCode().isBlank() || r.languageCode().length() > 16
                || r.status() == null || r.sourceStageRunId() == null
                || r.segments() == null || r.segments().isEmpty()
                || r.coverage() == null || r.speakers() == null
                || (r.durationMs() != null && r.durationMs() < 0)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
        }
        for (SegmentResult s : r.segments()) {
            if (s == null || s.ordinal() < 0 || s.startMs() < 0 || s.endMs() <= s.startMs()
                    || (r.durationMs() != null && s.endMs() > r.durationMs())
                    || s.text() == null || s.text().isBlank()
                    || !List.of("ACCEPTED", "SUSPICIOUS", "UNRESOLVED").contains(s.qualityStatus())) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
            }
        }
        for (CoverageResult c : r.coverage()) {
            if (c == null || c.startMs() < 0 || c.endMs() <= c.startMs() || c.retryCount() < 0
                    || (r.durationMs() != null && c.endMs() > r.durationMs())
                    || !List.of("COVERED", "SUSPICIOUS", "UNRESOLVED_ERROR").contains(c.coverageStatus())) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
            }
        }
        List<String> labels = new ArrayList<>();
        for (SpeakerResult s : r.speakers()) {
            if (s == null || s.label() == null || s.label().isBlank() || s.label().length() > 64
                    || labels.contains(s.label())) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
            }
            labels.add(s.label());
        }
        for (SegmentResult s : r.segments()) {
            if (s.speakerLabel() != null && !labels.contains(s.speakerLabel())) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
            }
        }
    }

    @Transactional(readOnly = true)
    public Optional<TranscriptView> current(UUID meetingId) {
        List<Header> headers = this.jdbc.query("""
            SELECT id,meeting_id,source_media_id,processing_job_id,version_number,language_code,status,
              duration_ms,finalized_at FROM transcripts WHERE meeting_id=? AND is_current
            """, (rs, row) -> new Header(rs.getObject("id", UUID.class), rs.getObject("meeting_id", UUID.class),
                rs.getObject("source_media_id", UUID.class), rs.getObject("processing_job_id", UUID.class),
                rs.getInt("version_number"), rs.getString("language_code"), rs.getString("status"),
                nullableLong(rs, "duration_ms"), rs.getObject("finalized_at", OffsetDateTime.class)), meetingId);
        if (headers.isEmpty()) return Optional.empty();
        Header h = headers.getFirst();
        List<SegmentView> segments = this.jdbc.query("""
            SELECT s.id,s.ordinal,s.start_ms,s.end_ms,s.current_text,s.quality_status,
              s.speaker_cluster_id,s.version,c.label FROM transcript_segments s
            LEFT JOIN speaker_clusters c ON c.id=s.speaker_cluster_id AND c.transcript_id=s.transcript_id
            WHERE s.transcript_id=? ORDER BY s.ordinal
            """, (rs, row) -> new SegmentView(rs.getObject("id", UUID.class), rs.getInt("ordinal"),
                rs.getLong("start_ms"), rs.getLong("end_ms"), rs.getString("current_text"),
                rs.getString("quality_status"), rs.getObject("speaker_cluster_id", UUID.class),
                rs.getString("label"), rs.getLong("version")), h.id());
        return Optional.of(new TranscriptView(h.id(), h.meetingId(), h.mediaId(), h.jobId(), h.version(),
            h.language(), h.status(), h.duration(), h.finalizedAt(), segments));
    }

    @Transactional(readOnly = true)
    public List<CoverageView> coverage(UUID meetingId) {
        return this.jdbc.query("""
            SELECT r.id,r.start_ms,r.end_ms,r.coverage_status,r.recovered,r.retry_count
            FROM transcript_coverage_regions r JOIN transcripts t ON t.id=r.transcript_id
            WHERE t.meeting_id=? AND t.is_current ORDER BY r.start_ms,r.id
            """, (rs, row) -> new CoverageView(rs.getObject("id", UUID.class), rs.getLong("start_ms"),
                rs.getLong("end_ms"), rs.getString("coverage_status"), rs.getBoolean("recovered"),
                rs.getInt("retry_count")), meetingId);
    }

    @Transactional(readOnly = true)
    public List<SpeakerView> speakers(UUID meetingId) {
        return this.jdbc.query("""
            SELECT c.id,c.label,m.user_id,u.display_name FROM speaker_clusters c
            JOIN transcripts t ON t.id=c.transcript_id
            LEFT JOIN speaker_mappings m ON m.speaker_cluster_id=c.id AND m.superseded_at IS NULL
            LEFT JOIN users u ON u.id=m.user_id
            WHERE t.meeting_id=? AND t.is_current ORDER BY c.created_at,c.id
            """, (rs, row) -> new SpeakerView(rs.getObject("id", UUID.class), rs.getString("label"),
                rs.getObject("user_id", UUID.class), rs.getString("display_name")), meetingId);
    }

    public CorrectionView correct(UUID meetingId, UUID segmentId, UUID actorId,
            String text, String reason, long expectedVersion) {
        List<SegmentState> rows = this.jdbc.query("""
            SELECT s.id,s.current_text,s.quality_status,s.version FROM transcript_segments s
            JOIN transcripts t ON t.id=s.transcript_id
            WHERE t.meeting_id=? AND t.is_current AND s.id=? FOR UPDATE OF s
            """, (rs, row) -> new SegmentState(rs.getObject("id", UUID.class), rs.getString("current_text"),
                rs.getString("quality_status"), rs.getLong("version")), meetingId, segmentId);
        if (rows.isEmpty()) throw notFound();
        SegmentState old = rows.getFirst();
        if (old.version() != expectedVersion) throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
        if (old.text().equals(text)) return new CorrectionView(segmentId, old.text(), old.quality(), old.version(), null, null);
        int revision = this.jdbc.queryForObject(
            "SELECT COALESCE(MAX(revision_number),0)+1 FROM transcript_segment_revisions WHERE segment_id=?",
            Integer.class, segmentId);
        OffsetDateTime now = OffsetDateTime.now();
        this.jdbc.update("""
            INSERT INTO transcript_segment_revisions(id,segment_id,revision_number,previous_text,new_text,
              edited_by_user_id,edit_reason,created_at) VALUES (?,?,?,?,?,?,?,?)
            """, UUID.randomUUID(), segmentId, revision, old.text(), text, actorId, reason, now);
        this.jdbc.update("""
            UPDATE transcript_segments SET current_text=?,quality_status='ACCEPTED',corrected_by_user_id=?,
              corrected_at=?,updated_at=?,version=version+1 WHERE id=? AND version=?
            """, text, actorId, now, now, segmentId, expectedVersion);
        return new CorrectionView(segmentId, text, "ACCEPTED", expectedVersion + 1, actorId, now);
    }

    public SpeakerView mapSpeaker(UUID meetingId, UUID clusterId, UUID userId, UUID actorId) {
        List<SpeakerKey> clusters = this.jdbc.query("""
            SELECT c.id FROM speaker_clusters c JOIN transcripts t ON t.id=c.transcript_id
            WHERE t.meeting_id=? AND t.is_current AND c.id=? FOR UPDATE OF c
            """, (rs, row) -> new SpeakerKey(rs.getObject(1, UUID.class)), meetingId, clusterId);
        if (clusters.isEmpty()) throw notFound();
        this.jdbc.update("UPDATE speaker_mappings SET superseded_at=CURRENT_TIMESTAMP "
            + "WHERE speaker_cluster_id=? AND superseded_at IS NULL", clusterId);
        if (userId != null) {
            this.jdbc.update("""
                INSERT INTO speaker_mappings(id,speaker_cluster_id,user_id,mapped_by_user_id)
                VALUES (?,?,?,?)
                """, UUID.randomUUID(), clusterId, userId, actorId);
        }
        return this.jdbc.query("""
            SELECT c.id,c.label,m.user_id,u.display_name FROM speaker_clusters c
            LEFT JOIN speaker_mappings m ON m.speaker_cluster_id=c.id AND m.superseded_at IS NULL
            LEFT JOIN users u ON u.id=m.user_id WHERE c.id=?
            """, (rs, row) -> new SpeakerView(rs.getObject("id", UUID.class), rs.getString("label"),
                rs.getObject("user_id", UUID.class), rs.getString("display_name")), clusterId).getFirst();
    }

    private String encode(Map<String, Object> value) {
        if (value == null) return null;
        try { return this.json.writeValueAsString(value); }
        catch (JacksonException e) { throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY); }
    }
    private static Long nullableLong(ResultSet rs, String name) throws SQLException {
        long value = rs.getLong(name);
        return rs.wasNull() ? null : value;
    }
    private static ResponseStatusException notFound() { return new ResponseStatusException(HttpStatus.NOT_FOUND); }
    private record Publication(UUID id, String digest) {}
    private record Header(UUID id, UUID meetingId, UUID mediaId, UUID jobId, int version,
            String language, String status, Long duration, OffsetDateTime finalizedAt) {}
    private record SegmentState(UUID id, String text, String quality, long version) {}
    private record SpeakerKey(UUID id) {}
}
