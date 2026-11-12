package com.sme.meetingassistant.api.knowledge;

import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.observability.RequestIdContext;
import com.sme.meetingassistant.api.transcript.service.TranscriptSnapshotCapture;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;

/**
 * Core-owned application boundary for durable knowledge indexing intents.
 * Callers invoke it after their canonical mutation and while their transaction
 * still owns the normal meeting/source lock. No broker or object-store I/O is
 * performed here.
 */
@Service
public class KnowledgeIndexingProducer {
    public static final String EVENT_TYPE = "KNOWLEDGE_INDEXING_REQUESTED";
    public static final String AGGREGATE_TYPE = "KNOWLEDGE_SOURCE";
    private static final int MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
    private static final String UUID_PATTERN = "[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}";

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final TranscriptSnapshotCapture transcriptSnapshots;
    private final MediaProperties properties;

    public KnowledgeIndexingProducer(JdbcTemplate jdbc, ObjectMapper json,
            TranscriptSnapshotCapture transcriptSnapshots, MediaProperties properties) {
        this.jdbc = jdbc;
        this.json = json;
        this.transcriptSnapshots = transcriptSnapshots;
        this.properties = properties;
    }

    /**
     * Persist one event only when the source is currently eligible. MANDATORY is
     * deliberate: a caller cannot accidentally create an indexing intent in a
     * transaction separate from its canonical source transition.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public Optional<KnowledgeIndexingEvent> request(String sourceType, UUID sourceId, UUID meetingId) {
        if (!properties.getKnowledgeIndexing().isEnabled()) return Optional.empty();
        if (sourceType == null || sourceId == null || meetingId == null) {
            throw new IllegalArgumentException("Knowledge source identity is required.");
        }
        Candidate candidate = switch (sourceType) {
            case "TRANSCRIPT" -> transcript(sourceId, meetingId);
            case "SUMMARY" -> summary(sourceId, meetingId);
            case "DECISION" -> decision(sourceId, meetingId);
            case "ACTION_ITEM" -> actionItem(sourceId, meetingId);
            default -> throw new IllegalArgumentException("Unsupported knowledge source type.");
        };
        if (candidate == null) {
            return requestLifecycleForSource(sourceType, sourceId, meetingId, null,
                "INVALIDATE", "ELIGIBILITY_CHANGED", null);
        }

        GenerationSpec generation = configuredGeneration();
        Optional<KnowledgeIndexingEvent> event = createUpsert(candidate, generation,
            "NEW_REVISION", 0, null, false);
        retireObsoleteSources(candidate);
        return event;
    }

    /**
     * A transcript revision supersedes previously indexed Summary/Decision
     * sources whose pinned transcript evidence is no longer current.
     * Caller already owns the meeting row lock and source mutation transaction;
     * invalidation intents are durable in that very transaction.
     *
     * Human-confirmed Action Items retain their independent business authority.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void invalidateStaleTranscriptDependents(UUID meetingId) {
        if (!properties.getKnowledgeIndexing().isEnabled()) return;
        if (meetingId == null) throw new IllegalArgumentException("Meeting identity is required");
        List<DerivedSource> tracked = jdbc.query("""
            SELECT DISTINCT source_type,source_id
              FROM knowledge_indexing_work
             WHERE meeting_id=? AND operation='UPSERT'
               AND source_type IN ('SUMMARY','DECISION')
             ORDER BY source_type,source_id
            """, (rs,i)->new DerivedSource(rs.getString("source_type"),
                rs.getObject("source_id",UUID.class)),meetingId);
        for (DerivedSource derived:tracked) {
            boolean eligible=switch (derived.type()) {
                case "SUMMARY" -> summary(derived.id(),meetingId)!=null;
                case "DECISION" -> decision(derived.id(),meetingId)!=null;
                default -> throw new IllegalStateException("Unsupported derived source");
            };
            if (!eligible) {
                requestLifecycleForSource(derived.type(),derived.id(),meetingId,
                    null,"INVALIDATE","SOURCE_SUPERSEDED",null);
            }
        }
    }
    private record DerivedSource(String type, UUID id) {}

    /** Create a same-revision repair intent without changing canonical source state. */
    @Transactional(propagation = Propagation.MANDATORY)
    public Optional<KnowledgeIndexingEvent> requestReindex(String sourceType, UUID sourceId,
            UUID meetingId, String generationId, UUID requestedByUserId) {
        if (!properties.getKnowledgeIndexing().isEnabled()) return Optional.empty();
        if (sourceType == null || sourceId == null || meetingId == null) {
            throw new IllegalArgumentException("Knowledge source identity is required.");
        }
        Candidate candidate = switch (sourceType) {
            case "TRANSCRIPT" -> transcript(sourceId, meetingId);
            case "SUMMARY" -> summary(sourceId, meetingId);
            case "DECISION" -> decision(sourceId, meetingId);
            case "ACTION_ITEM" -> actionItem(sourceId, meetingId);
            default -> throw new IllegalArgumentException("Unsupported knowledge source type.");
        };
        if (candidate == null) return Optional.empty();
        GenerationSpec generation = generation(generationId);
        long sequence = jdbc.queryForObject("""
            SELECT COALESCE(MAX(intent_sequence), -1) + 1
              FROM knowledge_indexing_work
             WHERE source_type=? AND source_id=? AND source_revision=?
               AND index_generation_id=? AND operation='UPSERT'
            """, Long.class, sourceType, sourceId, candidate.revision(), generation.id());
        return createUpsert(candidate, generation, "REINDEX_REQUESTED", sequence,
            requestedByUserId, true);
    }

    /** Reconcile an exact historical revision; never re-UPSERT the current revision in its place. */
    @Transactional(propagation = Propagation.MANDATORY)
    public Optional<KnowledgeIndexingEvent> requestInvalidateRevision(String sourceType, UUID sourceId,
            UUID meetingId, long sourceRevision, UUID requestedByUserId) {
        if (sourceRevision < 0) throw new IllegalArgumentException("Invalid source revision");
        return requestLifecycleForSource(sourceType, sourceId, meetingId, sourceRevision,
            "INVALIDATE", "RECONCILIATION_REQUESTED", requestedByUserId);
    }

    /** Explicit Core-authorized lifecycle request used by deletion/retention controls. */
    @Transactional(propagation = Propagation.MANDATORY)
    public Optional<KnowledgeIndexingEvent> requestDelete(String sourceType, UUID sourceId,
            UUID meetingId, UUID requestedByUserId) {
        return requestLifecycleForSource(sourceType, sourceId, meetingId, null,
            "DELETE", "SOURCE_DELETED", requestedByUserId);
    }

    private Optional<KnowledgeIndexingEvent> createUpsert(Candidate candidate, GenerationSpec generation,
            String reason, long intentSequence, UUID requestedByUserId, boolean repair) {
        if (!repair && Boolean.TRUE.equals(jdbc.queryForObject("""
            SELECT EXISTS(
                SELECT 1 FROM knowledge_indexing_work
                 WHERE source_type=? AND source_id=? AND source_revision=?
                   AND index_generation_id=? AND operation='UPSERT' AND intent_sequence=0
            )
            """, Boolean.class, candidate.sourceType(), candidate.sourceId(), candidate.revision(), generation.id()))) {
            return Optional.empty();
        }

        if (!repair) {
            // A newer canonical revision fences every older execution before its
            // replacement is published. Cleanup is a separate immutable intent.
            jdbc.update("""
                UPDATE knowledge_indexing_work
                   SET state='SUPERSEDED', claim_token=NULL, claim_request_id=NULL,
                       claim_fingerprint=NULL, owner_certificate_sha256=NULL,
                       claim_expires_at=NULL, updated_at=CURRENT_TIMESTAMP
                 WHERE source_type=? AND source_id=? AND source_revision<?
                   AND operation='UPSERT' AND state NOT IN ('SUPERSEDED','TERMINAL_FAILURE')
                """, candidate.sourceType(), candidate.sourceId(), candidate.revision());
        }

        Snapshot stored = snapshot(candidate);
        KnowledgeIndexingEvent event = event(candidate, stored, generation, "UPSERT", reason);
        insertEventAndWork(event, intentSequence, requestedByUserId);
        return Optional.of(event);
    }

    private Optional<KnowledgeIndexingEvent> requestLifecycleForSource(String sourceType, UUID sourceId,
            UUID meetingId, Long revision, String operation, String reason, UUID requestedByUserId) {
        if (!properties.getKnowledgeIndexing().isEnabled()) return Optional.empty();
        if (sourceType == null || sourceId == null || meetingId == null
                || !Set.of("INVALIDATE", "DELETE").contains(operation)) {
            throw new IllegalArgumentException("Invalid knowledge lifecycle identity.");
        }
        List<WorkTarget> targets = jdbc.query("""
            SELECT DISTINCT ON (source_revision,index_generation_id)
                   source_revision,index_generation_id,configuration_version,
                   configuration_sha256,tokenizer_id
              FROM knowledge_indexing_work
             WHERE meeting_id=? AND source_type=? AND source_id=? AND operation='UPSERT'
               AND (CAST(? AS BIGINT) IS NULL OR source_revision=CAST(? AS BIGINT))
             ORDER BY source_revision,index_generation_id,intent_sequence DESC
            """, (rs, row) -> new WorkTarget(rs.getLong("source_revision"),
                rs.getString("index_generation_id"), rs.getString("configuration_version"),
                rs.getString("configuration_sha256"), rs.getString("tokenizer_id")),
            meetingId, sourceType, sourceId, revision, revision);
        if (targets.isEmpty()) return Optional.empty();
        KnowledgeIndexingEvent first = null;
        for (WorkTarget target : targets) {
            if (Boolean.TRUE.equals(jdbc.queryForObject("""
                SELECT EXISTS(
                    SELECT 1 FROM knowledge_indexing_work
                     WHERE source_type=? AND source_id=? AND source_revision=?
                       AND index_generation_id=? AND operation=?
                )
                """, Boolean.class, sourceType, sourceId, target.revision(),
                target.generationId(), operation))) continue;

            GenerationSpec generation = new GenerationSpec(target.generationId(),
                target.configurationVersion(), target.configurationSha256(), target.tokenizerId());
            KnowledgeIndexingEvent event = event(new Candidate(sourceType, sourceId, meetingId,
                target.revision(), new byte[0]), null, generation, operation, reason);
            insertEventAndWork(event, 0, requestedByUserId);
            if (first == null) first = event;
        }
        return Optional.ofNullable(first);
    }

    private void retireObsoleteSources(Candidate candidate) {
        // Every previously indexed revision must eventually be removed, not
        // merely the immediately previous revision. A skipped publication or a
        // repair of a historical generation can leave older points behind.
        // For TRANSCRIPT/SUMMARY, a new current identity also supersedes
        // previously indexed identities within the same meeting. Decisions and
        // official action items have independent identities and business history.
        List<RetiredRevision> retired = jdbc.query("""
            SELECT DISTINCT source_id,source_revision FROM knowledge_indexing_work
             WHERE meeting_id=? AND source_type=? AND operation='UPSERT'
               AND ((source_id=? AND source_revision<?)
                    OR (? IN ('TRANSCRIPT','SUMMARY') AND source_id<>?))
             ORDER BY source_id,source_revision
            """, (rs, row) -> new RetiredRevision(
                rs.getObject("source_id", UUID.class), rs.getLong("source_revision")),
            candidate.meetingId(), candidate.sourceType(), candidate.sourceId(),
            candidate.revision(), candidate.sourceType(), candidate.sourceId());
        for (RetiredRevision source : retired) {
            requestLifecycleForSource(candidate.sourceType(), source.sourceId(), candidate.meetingId(),
                source.revision(), "INVALIDATE", "SOURCE_SUPERSEDED", null);
        }
    }
    private record RetiredRevision(UUID sourceId, long revision) { }

    private Snapshot snapshot(Candidate candidate) {
        byte[] bytes = candidate.snapshotBytes();
        String snapshotSha = digest(bytes);
        long snapshotSize = bytes.length;
        List<Snapshot> existing = jdbc.query("""
            SELECT id,sha256,size_bytes FROM knowledge_source_snapshots
             WHERE source_type=? AND source_id=? AND source_revision=?
            """, (rs, row) -> new Snapshot(rs.getObject("id", UUID.class),
                rs.getString("sha256"), rs.getLong("size_bytes")),
            candidate.sourceType(), candidate.sourceId(), candidate.revision());
        if (!existing.isEmpty()) {
            Snapshot stored = existing.getFirst();
            if (!snapshotSha.equals(stored.sha256()) || snapshotSize != stored.sizeBytes()) {
                throw new IllegalStateException("Canonical knowledge revision has conflicting snapshot bytes.");
            }
            return stored;
        }
        UUID snapshotId = snapshotId(bytes);
        jdbc.update("""
            INSERT INTO knowledge_source_snapshots(
                id,meeting_id,source_type,source_id,source_revision,payload,sha256,size_bytes)
            VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT (source_type,source_id,source_revision) DO NOTHING
            """, snapshotId, candidate.meetingId(), candidate.sourceType(), candidate.sourceId(),
            candidate.revision(), bytes, snapshotSha, snapshotSize);
        Snapshot stored = jdbc.queryForObject("""
            SELECT id,sha256,size_bytes FROM knowledge_source_snapshots
             WHERE source_type=? AND source_id=? AND source_revision=?
            """, (rs, row) -> new Snapshot(rs.getObject("id", UUID.class),
                rs.getString("sha256"), rs.getLong("size_bytes")),
            candidate.sourceType(), candidate.sourceId(), candidate.revision());
        if (!snapshotSha.equals(stored.sha256()) || snapshotSize != stored.sizeBytes()) {
            throw new IllegalStateException("Canonical knowledge revision has conflicting snapshot bytes.");
        }
        return stored;
    }

    private KnowledgeIndexingEvent event(Candidate candidate, Snapshot snapshot,
            GenerationSpec generation, String operation, String reason) {
        UUID eventId = UUID.randomUUID();
        return new KnowledgeIndexingEvent(eventId, OffsetDateTime.now(ZoneOffset.UTC), requestId(eventId),
            candidate.meetingId(), candidate.sourceType(), candidate.sourceId(), candidate.revision(),
            snapshot == null ? null : snapshot.id(), snapshot == null ? null : snapshot.sha256(),
            snapshot == null ? 0 : snapshot.sizeBytes(), generation.id(), generation.configurationVersion(),
            generation.configurationSha256(), generation.tokenizerId(), operation, reason);
    }

    private void insertEventAndWork(KnowledgeIndexingEvent event, long intentSequence,
            UUID requestedByUserId) {
        String payload;
        try {
            payload = json.writeValueAsString(event.payload());
        } catch (JacksonException failure) {
            throw new IllegalStateException("Knowledge indexing event serialization failed.", failure);
        }
        jdbc.update("""
            INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,occurred_at)
            VALUES (?,?,?,?,CAST(? AS jsonb),?)
            """, event.eventId(), AGGREGATE_TYPE, event.sourceId(), EVENT_TYPE, payload,
            event.occurredAt());
        jdbc.update("""
            INSERT INTO knowledge_indexing_work(
                event_id,meeting_id,source_type,source_id,source_revision,snapshot_id,
                snapshot_sha256,snapshot_size_bytes,index_generation_id,configuration_version,
                configuration_sha256,tokenizer_id,operation,reason,intent_sequence,requested_by_user_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, event.eventId(), event.meetingId(), event.sourceType(), event.sourceId(),
            event.sourceRevision(), event.snapshotId(), event.snapshotSha256(),
            event.snapshotSizeBytes() == 0 ? null : event.snapshotSizeBytes(), event.indexGenerationId(),
            event.configurationVersion(), event.configurationSha256(), event.tokenizerId(),
            event.operation(), event.reason(), intentSequence, requestedByUserId);
    }

    private GenerationSpec configuredGeneration() {
        var config = properties.getKnowledgeIndexing();
        return new GenerationSpec(config.getGenerationId(), config.getConfigurationVersion(),
            config.getConfigurationSha256(), config.getTokenizerId());
    }

    private GenerationSpec generation(String generationId) {
        if (generationId == null || generationId.isBlank()) return configuredGeneration();
        return jdbc.query("""
            SELECT generation_id,configuration_version,configuration_sha256,tokenizer_id
              FROM knowledge_index_generations
             WHERE generation_id=? AND state IN ('PREPARING','READY','ACTIVE')
            """, (rs, row) -> new GenerationSpec(rs.getString("generation_id"),
                rs.getString("configuration_version"), rs.getString("configuration_sha256"),
                rs.getString("tokenizer_id")), generationId).stream().findFirst()
            .orElseThrow(() -> new IllegalArgumentException("Knowledge index generation is not ready."));
    }

    private Candidate transcript(UUID sourceId, UUID meetingId) {
        TranscriptSnapshotCapture.Captured current;
        try {
            current = transcriptSnapshots.capture(meetingId);
        } catch (ResponseStatusException unavailable) {
            return null;
        }
        if (!sourceId.equals(current.transcriptId())
                || !List.of("READY", "READY_WITH_WARNINGS").contains(current.status())
                || current.bytes().length == 0) return null;
        byte[] payload = current.bytes();
        return new Candidate("TRANSCRIPT", sourceId, meetingId, current.contentRevision(),
            wrap("TRANSCRIPT", meetingId, sourceId, current.contentRevision(), payload, true, "RECONCILED"));
    }

    private Candidate summary(UUID sourceId, UUID meetingId) {
        List<SummaryRow> rows = jdbc.query("""
            SELECT s.id,s.meeting_id,s.version_number,s.content,s.source_type,s.quality_status,
                   s.is_current,s.processing_job_id,s.transcript_id,s.content_revision,s.selection_epoch,
                   s.ai_warning_codes,current_source.id AS current_transcript_id,
                   current_source.content_revision AS current_transcript_revision,
                   current_source.status AS current_transcript_status
              FROM meeting_summary_versions s
              LEFT JOIN transcripts current_source
                ON current_source.meeting_id=s.meeting_id AND current_source.is_current
             WHERE s.meeting_id=? AND s.id=?
            """, (rs, row) -> new SummaryRow(rs.getObject("id", UUID.class),
                rs.getObject("meeting_id", UUID.class), rs.getInt("version_number"),
                rs.getString("content"), rs.getString("source_type"), rs.getString("quality_status"),
                rs.getBoolean("is_current"), rs.getObject("processing_job_id", UUID.class),
                rs.getObject("transcript_id", UUID.class), nullableLong(rs, "content_revision"),
                rs.getLong("selection_epoch"), rs.getString("ai_warning_codes"),
                rs.getObject("current_transcript_id", UUID.class), nullableLong(rs, "current_transcript_revision"),
                rs.getString("current_transcript_status")), meetingId, sourceId);
        if (rows.size() != 1) return null;
        SummaryRow row = rows.getFirst();
        boolean stale = row.transcriptId() != null && (row.currentTranscriptId() == null
            || !row.transcriptId().equals(row.currentTranscriptId())
            || !java.util.Objects.equals(row.contentRevision(), row.currentTranscriptRevision())
            || !List.of("READY", "READY_WITH_WARNINGS").contains(row.currentTranscriptStatus()));
        boolean eligible = row.isCurrent() && !stale
            && List.of("READY", "READY_WITH_WARNINGS").contains(row.qualityStatus());
        if (!eligible) return null;

        Map<String, Object> content = new LinkedHashMap<>();
        content.put("id", row.id().toString());
        content.put("meetingId", row.meetingId().toString());
        content.put("versionNumber", row.versionNumber());
        content.put("content", row.content());
        content.put("sourceType", row.sourceType());
        content.put("qualityStatus", row.qualityStatus());
        content.put("isCurrent", row.isCurrent());
        content.put("isApproved", true);
        content.put("isStale", false);
        put(content, "processingJobId", row.processingJobId());
        put(content, "transcriptId", row.transcriptId());
        put(content, "transcriptRevision", revision(row.contentRevision()));
        content.put("contentRevision", row.contentRevision());
        content.put("selectionEpoch", row.selectionEpoch());
        content.put("aiWarnings", csv(row.aiWarningCodes()));
        Map<String, Object> snapshot = snapshot("SUMMARY", row.meetingId(), row.id(), row.versionNumber(), content);
        return new Candidate("SUMMARY", row.id(), row.meetingId(), row.versionNumber(), bytes(snapshot));
    }

    private Candidate decision(UUID sourceId, UUID meetingId) {
        List<DecisionRow> rows = jdbc.query("""
            SELECT d.id,d.meeting_id,d.content,d.status,d.source_type,d.transcript_id,
                   d.content_revision,d.version,d.confirmed_at,d.confirmed_by_user_id,
                   array_to_string(r.result_warning_codes,',') AS ai_warning_codes,
                   current_source.id AS current_transcript_id,
                   current_source.content_revision AS current_transcript_revision,
                   current_source.status AS current_transcript_status
              FROM meeting_decisions d
              LEFT JOIN meeting_intelligence_result_receipts r
                ON r.id=d.result_receipt_id AND r.meeting_id=d.meeting_id
              LEFT JOIN transcripts current_source
                ON current_source.meeting_id=d.meeting_id AND current_source.is_current
             WHERE d.meeting_id=? AND d.id=?
            """, (rs, row) -> new DecisionRow(rs.getObject("id", UUID.class),
                rs.getObject("meeting_id", UUID.class), rs.getString("content"),
                rs.getString("status"), rs.getString("source_type"),
                rs.getObject("transcript_id", UUID.class), nullableLong(rs, "content_revision"),
                rs.getLong("version"), rs.getObject("confirmed_at", OffsetDateTime.class),
                rs.getObject("confirmed_by_user_id", UUID.class), rs.getString("ai_warning_codes"),
                rs.getObject("current_transcript_id", UUID.class), nullableLong(rs, "current_transcript_revision"),
                rs.getString("current_transcript_status")), meetingId, sourceId);
        if (rows.size() != 1) return null;
        DecisionRow row = rows.getFirst();
        boolean stale = row.transcriptId() != null && (row.currentTranscriptId() == null
            || !row.transcriptId().equals(row.currentTranscriptId())
            || !java.util.Objects.equals(row.contentRevision(), row.currentTranscriptRevision())
            || !List.of("READY", "READY_WITH_WARNINGS").contains(row.currentTranscriptStatus()));
        if (!"CONFIRMED".equals(row.status()) || stale) return null;

        Map<String, Object> content = new LinkedHashMap<>();
        content.put("id", row.id().toString());
        content.put("meetingId", row.meetingId().toString());
        content.put("content", row.content());
        content.put("status", row.status());
        content.put("sourceType", row.sourceType());
        content.put("evidenceSegmentIds", evidence("decision_evidence", "decision_id", sourceId));
        put(content, "transcriptId", row.transcriptId());
        put(content, "transcriptRevision", revision(row.contentRevision()));
        put(content, "contentRevision", row.contentRevision());
        content.put("version", row.version());
        content.put("isStale", false);
        put(content, "confirmedByUserId", row.confirmedByUserId());
        put(content, "confirmedAt", row.confirmedAt());
        put(content, "aiWarnings", csv(row.aiWarningCodes()));
        Map<String, Object> snapshot = snapshot("DECISION", row.meetingId(), row.id(), row.version(), content);
        return new Candidate("DECISION", row.id(), row.meetingId(), row.version(), bytes(snapshot));
    }

    private Candidate actionItem(UUID sourceId, UUID meetingId) {
        List<ActionRow> rows = jdbc.query("""
            SELECT id,meeting_id,title,details,status,assignee_user_id,due_date,source_type,
                   version,confirmed_by_user_id,confirmed_at,transcript_id,content_revision
              FROM action_items WHERE meeting_id=? AND id=?
            """, (rs, row) -> new ActionRow(rs.getObject("id", UUID.class),
                rs.getObject("meeting_id", UUID.class), rs.getString("title"), rs.getString("details"),
                rs.getString("status"), rs.getObject("assignee_user_id", UUID.class),
                rs.getObject("due_date", java.time.LocalDate.class), rs.getString("source_type"),
                rs.getLong("version"), rs.getObject("confirmed_by_user_id", UUID.class),
                rs.getObject("confirmed_at", OffsetDateTime.class), rs.getObject("transcript_id", UUID.class),
                nullableLong(rs, "content_revision")), meetingId, sourceId);
        if (rows.size() != 1) return null;
        ActionRow row = rows.getFirst();
        boolean official = "MANUAL".equals(row.sourceType()) || row.confirmedByUserId() != null;
        if (!official || "PROPOSED".equals(row.status())) return null;

        Map<String, Object> content = new LinkedHashMap<>();
        content.put("id", row.id().toString());
        content.put("meetingId", row.meetingId().toString());
        content.put("title", row.title());
        put(content, "details", row.details());
        content.put("status", row.status());
        content.put("sourceType", row.sourceType());
        content.put("isOfficial", true);
        put(content, "assigneeUserId", row.assigneeUserId());
        put(content, "dueDate", row.dueDate());
        content.put("version", row.version());
        put(content, "confirmedByUserId", row.confirmedByUserId());
        put(content, "confirmedAt", row.confirmedAt());
        put(content, "transcriptId", row.transcriptId());
        put(content, "transcriptRevision", revision(row.contentRevision()));
        put(content, "contentRevision", row.contentRevision());
        content.put("evidenceSegmentIds", evidence("action_item_evidence", "action_item_id", sourceId));
        Map<String, Object> snapshot = snapshot("ACTION_ITEM", row.meetingId(), row.id(), row.version(), content);
        return new Candidate("ACTION_ITEM", row.id(), row.meetingId(), row.version(), bytes(snapshot));
    }

    private Map<String, Object> snapshot(String type, UUID meetingId, UUID sourceId,
            long revision, Map<String, Object> content) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("contractVersion", "1.0");
        result.put("snapshotType", type);
        result.put("metadata", metadata(stableSnapshotId(type, sourceId, revision), meetingId,
            type, sourceId, revision));
        result.put("content", content);
        return result;
    }

    private byte[] wrap(String type, UUID meetingId, UUID sourceId, long revision,
            byte[] payloadBytes, boolean current, String representation) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("contractVersion", "1.0");
        result.put("snapshotType", type);
        result.put("metadata", metadata(stableSnapshotId(type, sourceId, revision), meetingId,
            type, sourceId, revision));
        result.put("current", current);
        result.put("representation", representation);
        try {
            result.put("payload", json.readTree(payloadBytes));
        } catch (JacksonException failure) {
            throw new IllegalStateException("Canonical transcript snapshot is invalid.", failure);
        }
        return bytes(result);
    }

    private UUID snapshotId(byte[] snapshotBytes) {
        try {
            String value = json.readTree(snapshotBytes).get("metadata").get("snapshotId").asString();
            return UUID.fromString(value);
        } catch (Exception invalid) {
            throw new IllegalStateException("Knowledge snapshot identity is invalid.", invalid);
        }
    }

    private static UUID stableSnapshotId(String sourceType, UUID sourceId, long revision) {
        String key = "sme-knowledge-snapshot-v1:" + sourceType + ":" + sourceId + ":" + revision;
        return UUID.nameUUIDFromBytes(key.getBytes(StandardCharsets.UTF_8));
    }

    private Map<String, Object> metadata(UUID snapshotId, UUID meetingId, String type,
            UUID sourceId, long revision) {
        Map<String, Object> sourceIdentity = new LinkedHashMap<>();
        sourceIdentity.put("sourceType", type);
        sourceIdentity.put("sourceId", sourceId.toString());
        sourceIdentity.put("meetingId", meetingId.toString());
        Map<String, Object> sourceRevision = new LinkedHashMap<>();
        sourceRevision.put("number", revision);
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("snapshotId", snapshotId.toString());
        metadata.put("meetingId", meetingId.toString());
        metadata.put("sourceIdentity", sourceIdentity);
        metadata.put("sourceRevision", sourceRevision);
        // The event reference authenticates the exact bytes. Snapshot-level
        // integrity is intentionally omitted because hashing a document that
        // contains its own digest would be self-referential.
        return metadata;
    }

    private List<String> evidence(String table, String ownerColumn, UUID sourceId) {
        return jdbc.query("SELECT transcript_segment_id FROM " + table
                + " WHERE " + ownerColumn + "=? ORDER BY transcript_segment_id",
            (rs, row) -> rs.getObject("transcript_segment_id", UUID.class).toString(), sourceId);
    }

    private static Map<String, Object> revision(Long number) {
        if (number == null) return null;
        return Map.of("number", number);
    }

    private static List<String> csv(String value) {
        if (value == null || value.isBlank()) return List.of();
        return List.of(value.split(","));
    }

    private static void put(Map<String, Object> map, String key, Object value) {
        if (value != null) map.put(key, value);
    }

    private byte[] bytes(Object value) {
        try {
            byte[] bytes = json.writeValueAsBytes(value);
            if (bytes.length < 1 || bytes.length > MAX_SNAPSHOT_BYTES) {
                throw new IllegalArgumentException("Knowledge snapshot exceeds the approved size bound.");
            }
            return bytes;
        } catch (JacksonException failure) {
            throw new IllegalStateException("Knowledge snapshot serialization failed.", failure);
        }
    }

    private static String digest(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    private static String requestId(UUID eventId) {
        String current = RequestIdContext.currentRequestId();
        return current != null && current.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
            ? current : eventId.toString();
    }

    private static Long nullableLong(java.sql.ResultSet rs, String name) throws java.sql.SQLException {
        long value = rs.getLong(name);
        return rs.wasNull() ? null : value;
    }

    private record Candidate(String sourceType, UUID sourceId, UUID meetingId, long revision,
            byte[] snapshotBytes) {
        private Candidate {
            snapshotBytes = snapshotBytes.clone();
        }
        @Override public byte[] snapshotBytes() { return snapshotBytes.clone(); }
    }

    private record Snapshot(UUID id, String sha256, long sizeBytes) { }
    private record GenerationSpec(String id, String configurationVersion,
            String configurationSha256, String tokenizerId) {
        private GenerationSpec {
            if (id == null || id.isBlank() || configurationVersion == null
                    || configurationVersion.isBlank() || configurationSha256 == null
                    || !configurationSha256.matches("[a-f0-9]{64}")
                    || tokenizerId == null || tokenizerId.isBlank()) {
                throw new IllegalStateException("Knowledge indexing generation is not configured.");
            }
        }
    }
    private record WorkTarget(long revision, String generationId, String configurationVersion,
            String configurationSha256, String tokenizerId) { }

    private record SummaryRow(UUID id, UUID meetingId, int versionNumber, String content,
            String sourceType, String qualityStatus, boolean isCurrent, UUID processingJobId,
            UUID transcriptId, Long contentRevision, long selectionEpoch, String aiWarningCodes,
            UUID currentTranscriptId, Long currentTranscriptRevision, String currentTranscriptStatus) { }
    private record DecisionRow(UUID id, UUID meetingId, String content, String status,
            String sourceType, UUID transcriptId, Long contentRevision, long version,
            OffsetDateTime confirmedAt, UUID confirmedByUserId, String aiWarningCodes,
            UUID currentTranscriptId, Long currentTranscriptRevision, String currentTranscriptStatus) { }
    private record ActionRow(UUID id, UUID meetingId, String title, String details, String status,
            UUID assigneeUserId, java.time.LocalDate dueDate, String sourceType, long version,
            UUID confirmedByUserId, OffsetDateTime confirmedAt, UUID transcriptId,
            Long contentRevision) { }
}
