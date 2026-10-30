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
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
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
        publishValidated(result, false);
    }

    /**
     * Only the application finalization coordinator should call this method,
     * after locking the meeting and verifying the active fenced worker claim.
     * This path admits RUNNING/RUNNING without allowing a standalone publication
     * to mark the processing stage or job successful.
     */
    @Transactional
    public void publishDuringFinalization(TranscriptResult result) {
        publishValidated(result, true);
        // The transaction must also commit stage and job success. Without this
        // check, an internal caller could accidentally persist a RUNNING-job
        // transcript without using the atomic finalization coordinator.
        if (!TransactionSynchronizationManager.isSynchronizationActive()
                || !TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("Atomic transcript publication requires a transaction.");
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void beforeCommit(boolean readOnly) {
                assertAtomicFinalizationCompleted(result);
            }
        });
    }

    private void assertAtomicFinalizationCompleted(TranscriptResult result) {
        boolean committedTogether = Boolean.TRUE.equals(this.jdbc.queryForObject("""
            SELECT EXISTS (
              SELECT 1 FROM transcripts t
              JOIN processing_jobs j ON j.id=t.processing_job_id
                AND j.meeting_id=t.meeting_id AND j.source_media_id=t.source_media_id
              JOIN processing_stage_runs s ON s.id=t.source_stage_run_id
                AND s.processing_job_id=j.id AND s.stage_code='FINALIZING_TRANSCRIPT'
              WHERE t.processing_job_id=? AND t.source_stage_run_id=?
                AND s.status IN ('SUCCEEDED','SUCCEEDED_WITH_WARNING')
                AND (
                  j.status IN ('COMPLETED','COMPLETED_WITH_WARNINGS')
                  OR (j.status='RUNNING' AND EXISTS (
                    SELECT 1 FROM processing_stage_runs pending
                    WHERE pending.processing_job_id=j.id AND pending.status='PENDING'
                      AND pending.stage_code IN ('GENERATING_SUMMARY', 'EXTRACTING_DECISIONS',
                                                 'EXTRACTING_ACTION_ITEMS', 'INDEXING')
                  ))
                )
            )
            """, Boolean.class, result.processingJobId(), result.sourceStageRunId()));
        if (!committedTogether) {
            throw new IllegalStateException(
                "Transcript, finalization stage and job must complete in one transaction.");
        }
    }

    private void publishValidated(TranscriptResult result, boolean runningFinalization) {
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

        List<String> finalized = this.jdbc.query("""
            SELECT sr.status FROM processing_jobs j JOIN meeting_media m
              ON m.meeting_id=j.meeting_id AND m.id=j.source_media_id
            JOIN processing_stage_runs sr ON sr.processing_job_id=j.id
              AND sr.id=? AND sr.stage_code='FINALIZING_TRANSCRIPT'
              AND sr.attempt_number = (
                SELECT MAX(x.attempt_number) FROM processing_stage_runs x
                WHERE x.processing_job_id=j.id AND x.stage_code=sr.stage_code)
            WHERE j.id=? AND j.meeting_id=? AND j.source_media_id=?
              AND m.status='AVAILABLE'
              AND (
                (? = TRUE AND sr.status='RUNNING' AND j.status='RUNNING')
                OR (? = FALSE AND sr.status IN ('SUCCEEDED','SUCCEEDED_WITH_WARNING')
                    AND j.status IN ('COMPLETED','COMPLETED_WITH_WARNINGS'))
              )
            """, (rs, row) -> rs.getString(1), result.sourceStageRunId(),
            result.processingJobId(), result.meetingId(), result.sourceMediaId(),
            runningFinalization, runningFinalization);
        if (finalized.size() != 1) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "Transcript source or finalization attempt is not eligible.");
        }
        validateQuality(result, "SUCCEEDED_WITH_WARNING".equals(finalized.getFirst()));
        // Job results are persisted even when not eligible for automatic promotion.
        List<CurrentTranscript> currentVersions = this.jdbc.query("""
            SELECT id,content_revision FROM transcripts
            WHERE meeting_id=? AND is_current
            """, (rs, row) -> new CurrentTranscript(
                rs.getObject("id", UUID.class), rs.getLong("content_revision")), result.meetingId());
        boolean newerJobExists = Boolean.TRUE.equals(this.jdbc.queryForObject("""
            SELECT EXISTS (
              SELECT 1 FROM processing_jobs candidate
              JOIN processing_jobs newer ON newer.meeting_id=candidate.meeting_id
              WHERE candidate.id=? AND candidate.meeting_id=?
                AND newer.id<>candidate.id
                AND (newer.reprocess_of_job_id=candidate.id
                  OR newer.created_at>candidate.created_at
                  OR (newer.created_at=candidate.created_at AND newer.id>candidate.id))
            )
            """, Boolean.class, result.processingJobId(), result.meetingId()));
        boolean promote = !newerJobExists
            && currentVersions.stream().noneMatch(current -> current.contentRevision() > 0);
        int version = this.jdbc.queryForObject(
            "SELECT COALESCE(MAX(version_number),0)+1 FROM transcripts WHERE meeting_id=?",
            Integer.class, result.meetingId());
        if (promote) {
            this.jdbc.update("UPDATE transcripts SET is_current=FALSE WHERE meeting_id=? AND is_current",
                result.meetingId());
        }
        UUID transcriptId = UUID.randomUUID();
        this.jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,source_stage_run_id,
              version_number,language_code,status,is_current,duration_ms,finalized_at,publication_sha256)
            VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,?)
            """, transcriptId, result.meetingId(), result.sourceMediaId(), result.processingJobId(),
            result.sourceStageRunId(), version, result.languageCode(), result.status().name(),
            promote, result.durationMs(), fingerprint);

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
        // There is speech text, so the independent region coverage report must be present.
        // An empty region map is not evidence that the audio was fully covered.
        if (r.coverage().isEmpty()) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                "Transcript requires independent speech coverage evidence.");
        }
    }

    /**
     * Validate coherence of the AI Core coverage report; actual VAD/source-audio
     * comparison is performed by AI Core, not inferred from transcript text.
     * Do not use arbitrary duration thresholds or treat a provider ACK as coverage.
     */
    private static void validateQuality(TranscriptResult result, boolean finalizationWarned) {
        boolean flaggedSegments = result.segments().stream()
            .anyMatch(segment -> !"ACCEPTED".equals(segment.qualityStatus()));
        boolean flaggedRegions = result.coverage().stream()
            .anyMatch(region -> !"COVERED".equals(region.coverageStatus()));
        boolean hasWarnings = flaggedSegments || flaggedRegions || finalizationWarned;
        if (result.status() == TranscriptIngestion.Status.READY && hasWarnings) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                "READY cannot contain unresolved speech, suspicious text, or stage warnings.");
        }
        if (result.status() == TranscriptIngestion.Status.READY_WITH_WARNINGS && !hasWarnings) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                "READY_WITH_WARNINGS requires quality evidence or a finalization warning.");
        }
        for (CoverageResult region : result.coverage()) {
            if (!"COVERED".equals(region.coverageStatus())) continue;
            boolean represented = result.segments().stream().anyMatch(segment ->
                "ACCEPTED".equals(segment.qualityStatus())
                    && intersects(segment.startMs(), segment.endMs(),
                        region.startMs(), region.endMs()));
            if (!represented) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "A COVERED speech region needs corresponding accepted transcript text.");
            }
        }
        for (SegmentResult segment : result.segments()) {
            boolean mapped = result.coverage().stream().anyMatch(region ->
                intersects(segment.startMs(), segment.endMs(), region.startMs(), region.endMs()));
            if (!mapped) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Transcript segments must be represented on the speech coverage timeline.");
            }
        }
    }

    private static boolean intersects(long leftStart, long leftEnd, long rightStart, long rightEnd) {
        return leftStart < rightEnd && rightStart < leftEnd;
    }

    @Transactional(readOnly = true)
    public Optional<TranscriptView> current(UUID meetingId) {
        List<Header> headers = this.jdbc.query("""
            SELECT id,meeting_id,source_media_id,processing_job_id,version_number,language_code,status,
              duration_ms,finalized_at,content_revision FROM transcripts WHERE meeting_id=? AND is_current
            """, (rs, row) -> new Header(rs.getObject("id", UUID.class), rs.getObject("meeting_id", UUID.class),
                rs.getObject("source_media_id", UUID.class), rs.getObject("processing_job_id", UUID.class),
                rs.getInt("version_number"), rs.getString("language_code"), rs.getString("status"),
                nullableLong(rs, "duration_ms"), rs.getObject("finalized_at", OffsetDateTime.class),
                rs.getLong("content_revision")), meetingId);
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
            h.language(), h.status(), h.duration(), h.finalizedAt(), h.contentRevision(), segments));
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
        lockMeeting(meetingId);
        List<SegmentState> rows = this.jdbc.query("""
            SELECT s.id,s.current_text,s.quality_status,s.version FROM transcript_segments s
            JOIN transcripts t ON t.id=s.transcript_id
            WHERE t.meeting_id=? AND t.is_current AND s.id=? FOR UPDATE OF s
            """, (rs, row) -> new SegmentState(rs.getObject("id", UUID.class), rs.getString("current_text"),
                rs.getString("quality_status"), rs.getLong("version")), meetingId, segmentId);
        if (rows.isEmpty()) throw notFound();
        SegmentState old = rows.getFirst();
        if (old.version() != expectedVersion) throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
        // Explicit acceptance of suspicious text is a review decision even if text is unchanged.
        if (old.text().equals(text) && "ACCEPTED".equals(old.quality())) {
            return new CorrectionView(segmentId, old.text(), old.quality(), old.version(), null, null);
        }
        int revision = this.jdbc.queryForObject(
            "SELECT COALESCE(MAX(revision_number),0)+1 FROM transcript_segment_revisions WHERE segment_id=?",
            Integer.class, segmentId);
        OffsetDateTime now = OffsetDateTime.now();
        this.jdbc.update("""
            INSERT INTO transcript_segment_revisions(id,segment_id,revision_number,previous_text,new_text,
              edited_by_user_id,edit_reason,created_at) VALUES (?,?,?,?,?,?,?,?)
            """, UUID.randomUUID(), segmentId, revision, old.text(), text, actorId, reason, now);
        int changed = this.jdbc.update("""
            UPDATE transcript_segments SET current_text=?,quality_status='ACCEPTED',corrected_by_user_id=?,
              corrected_at=?,updated_at=?,version=version+1 WHERE id=? AND version=?
            """, text, actorId, now, now, segmentId, expectedVersion);
        if (changed != 1) throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
        increaseContentRevision(meetingId);
        return new CorrectionView(segmentId, text, "ACCEPTED", expectedVersion + 1, actorId, now);
    }

    public SpeakerView mapSpeaker(UUID meetingId, UUID clusterId, UUID userId, UUID actorId) {
        lockMeeting(meetingId);
        List<SpeakerKey> clusters = this.jdbc.query("""
            SELECT c.id FROM speaker_clusters c JOIN transcripts t ON t.id=c.transcript_id
            WHERE t.meeting_id=? AND t.is_current AND c.id=? FOR UPDATE OF c
            """, (rs, row) -> new SpeakerKey(rs.getObject(1, UUID.class)), meetingId, clusterId);
        if (clusters.isEmpty()) throw notFound();
        List<UUID> mappings = this.jdbc.query("""
            SELECT user_id FROM speaker_mappings
            WHERE speaker_cluster_id=? AND superseded_at IS NULL
            """, (rs, row) -> rs.getObject(1, UUID.class), clusterId);
        UUID existingUser = mappings.isEmpty() ? null : mappings.getFirst();
        if (java.util.Objects.equals(existingUser, userId)) return speakerByCluster(clusterId);
        this.jdbc.update("UPDATE speaker_mappings SET superseded_at=CURRENT_TIMESTAMP "
            + "WHERE speaker_cluster_id=? AND superseded_at IS NULL", clusterId);
        if (userId != null) {
            this.jdbc.update("""
                INSERT INTO speaker_mappings(id,speaker_cluster_id,user_id,mapped_by_user_id)
                VALUES (?,?,?,?)
                """, UUID.randomUUID(), clusterId, userId, actorId);
        }
        increaseContentRevision(meetingId);
        return speakerByCluster(clusterId);
    }

    private SpeakerView speakerByCluster(UUID clusterId) {
        return this.jdbc.query("""
            SELECT c.id,c.label,m.user_id,u.display_name FROM speaker_clusters c
            LEFT JOIN speaker_mappings m ON m.speaker_cluster_id=c.id AND m.superseded_at IS NULL
            LEFT JOIN users u ON u.id=m.user_id WHERE c.id=?
            """, (rs, row) -> new SpeakerView(rs.getObject("id", UUID.class), rs.getString("label"),
                rs.getObject("user_id", UUID.class), rs.getString("display_name")), clusterId).getFirst();
    }

    /** Shared meeting lock, acquired before re-checking edit authorization. */
    public void lockMeetingForReview(UUID meetingId) { lockMeeting(meetingId); }

    private void lockMeeting(UUID meetingId) {
        this.jdbc.query("SELECT id FROM meetings WHERE id=? FOR UPDATE",
            (rs, row) -> rs.getObject(1, UUID.class), meetingId).stream().findFirst()
            .orElseThrow(TranscriptRepository::notFound);
    }

    private void increaseContentRevision(UUID meetingId) {
        int changed = this.jdbc.update("""
            UPDATE transcripts SET content_revision=content_revision+1
            WHERE meeting_id=? AND is_current
            """, meetingId);
        if (changed != 1) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "Current transcript changed during review.");
        }
    }


    /**
     * Captured by downstream workers and verified when persisting derived outputs.
     * Status is part of the identity: warnings must not be silently trusted.
     */
    @Transactional(readOnly = true)
    public Optional<TranscriptSource> currentSource(UUID meetingId) {
        return this.jdbc.query("""
            SELECT id,content_revision,status FROM transcripts
            WHERE meeting_id=? AND is_current
            """, (rs, row) -> new TranscriptSource(
                rs.getObject("id", UUID.class), rs.getLong("content_revision"),
                rs.getString("status")), meetingId).stream().findFirst();
    }

    /**
     * Call inside the SAME transaction as downstream writes. This meeting lock
     * fences concurrent corrections, mapping changes and AI version promotion.
     */
    public void requireCurrentSource(UUID meetingId, TranscriptSource expected) {
        if (meetingId == null || expected == null || expected.transcriptId() == null
                || expected.contentRevision() < 0 || expected.status() == null) {
            throw new IllegalArgumentException("Transcript source revision is required.");
        }
        lockMeeting(meetingId);
        TranscriptSource current = currentSource(meetingId).orElseThrow(() ->
            new ResponseStatusException(HttpStatus.CONFLICT, "No current transcript is available."));
        if (!current.equals(expected)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "Transcript source changed; regenerate the derived result from current evidence.");
        }
    }

    public record TranscriptSource(UUID transcriptId, long contentRevision, String status) {}

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
    private record CurrentTranscript(UUID id, long contentRevision) {}
    private record Publication(UUID id, String digest) {}
    private record Header(UUID id, UUID meetingId, UUID mediaId, UUID jobId, int version,
            String language, String status, Long duration, OffsetDateTime finalizedAt,
            long contentRevision) {}
    private record SegmentState(UUID id, String text, String quality, long version) {}
    private record SpeakerKey(UUID id) {}
}
