package com.sme.meetingassistant.api.knowledge;

import com.sme.meetingassistant.api.media.MediaProperties;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/** Administrator-only control plane for durable knowledge repair and generation state. */
@Service
public class KnowledgeIndexingAdminService {
    private final JdbcTemplate jdbc;
    private final KnowledgeIndexingProducer producer;
    private final KnowledgeIndexingWorkerService worker;
    private final MediaProperties properties;

    public KnowledgeIndexingAdminService(JdbcTemplate jdbc, KnowledgeIndexingProducer producer,
            KnowledgeIndexingWorkerService worker, MediaProperties properties) {
        this.jdbc = jdbc;
        this.producer = producer;
        this.worker = worker;
        this.properties = properties;
    }

    @Transactional
    public Map<String, Object> reindex(String sourceType, UUID sourceId, UUID meetingId,
            String generationId, UUID requestedByUserId) {
        requireEnabled();
        KnowledgeIndexingEvent event = producer.requestReindex(sourceType, sourceId, meetingId,
                generationId, requestedByUserId).orElseThrow(() -> unavailableSource());
        return eventData(event);
    }

    @Transactional
    public Map<String, Object> delete(String sourceType, UUID sourceId, UUID meetingId,
            UUID requestedByUserId) {
        requireEnabled();
        KnowledgeIndexingEvent event = producer.requestDelete(sourceType, sourceId, meetingId,
                requestedByUserId).orElseThrow(() -> unavailableSource());
        return eventData(event);
    }

    @Transactional(readOnly = true)
    public Map<String, Object> generation(String generationId) {
        return jdbc.query("""
            SELECT generation_id,configuration_version,configuration_sha256,tokenizer_id,
                   collection_name,state,target_count,indexed_count,checkpoint_source_type,
                   checkpoint_source_id,last_error_code,last_error_summary,prepared_at,ready_at,
                   activated_at,retired_at,created_at,updated_at
              FROM knowledge_index_generations WHERE generation_id=?
            """, (rs, row) -> {
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("generationId", rs.getString("generation_id"));
                data.put("configurationVersion", rs.getString("configuration_version"));
                data.put("configurationSha256", rs.getString("configuration_sha256"));
                data.put("tokenizerId", rs.getString("tokenizer_id"));
                data.put("collectionName", rs.getString("collection_name"));
                data.put("state", rs.getString("state"));
                data.put("targetCount", rs.getLong("target_count"));
                data.put("indexedCount", rs.getLong("indexed_count"));
                data.put("checkpointSourceType", rs.getString("checkpoint_source_type"));
                data.put("checkpointSourceId", rs.getObject("checkpoint_source_id", UUID.class));
                data.put("lastErrorCode", rs.getString("last_error_code"));
                data.put("lastErrorSummary", rs.getString("last_error_summary"));
                data.put("preparedAt", rs.getObject("prepared_at"));
                data.put("readyAt", rs.getObject("ready_at"));
                data.put("activatedAt", rs.getObject("activated_at"));
                data.put("retiredAt", rs.getObject("retired_at"));
                data.put("createdAt", rs.getObject("created_at"));
                data.put("updatedAt", rs.getObject("updated_at"));
                return data;
            }, generationId).stream().findFirst().orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Knowledge generation was not found."));
    }

    @Transactional
    public Map<String, Object> prepare(String generationId, String configurationVersion,
            String configurationSha256, String tokenizerId, String collectionName) {
        requireEnabled();
        List<GenerationRow> existing = jdbc.query("""
            SELECT generation_id,configuration_version,configuration_sha256,tokenizer_id,collection_name,
                   state,target_count,indexed_count
              FROM knowledge_index_generations WHERE generation_id=? FOR UPDATE
            """, this::generationRow, generationId);
        if (!existing.isEmpty()) {
            GenerationRow row = existing.getFirst();
            if (!row.configurationVersion().equals(configurationVersion)
                    || !row.configurationSha256().equals(configurationSha256)
                    || !row.tokenizerId().equals(tokenizerId)
                    || !row.collectionName().equals(collectionName)) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Knowledge generation identity is immutable.");
            }
            return generation(generationId);
        }
        jdbc.update("""
            INSERT INTO knowledge_index_generations(
                generation_id,configuration_version,configuration_sha256,tokenizer_id,collection_name)
            VALUES (?,?,?,?,?)
            """, generationId, configurationVersion, configurationSha256, tokenizerId, collectionName);
        return generation(generationId);
    }

    @Transactional
    public Map<String, Object> refresh(String generationId) {
        requireEnabled();
        refreshLocked(generationId);
        return generation(generationId);
    }

    @Transactional
    public Map<String, Object> activate(String generationId) {
        requireEnabled();
        var rows = jdbc.query("""
            SELECT generation_id,configuration_version,configuration_sha256,tokenizer_id,collection_name,
                   state,target_count,indexed_count
              FROM knowledge_index_generations WHERE generation_id=? FOR UPDATE
            """, this::generationRow, generationId);
        if (rows.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        GenerationRow generation = rows.getFirst();
        if ("ACTIVE".equals(generation.state())) return generation(generationId);
        if ("PREPARING".equals(generation.state()) || "READY".equals(generation.state())) {
            refreshLocked(generationId);
            generation = jdbc.query("""
                SELECT generation_id,configuration_version,configuration_sha256,tokenizer_id,collection_name,
                       state,target_count,indexed_count
                  FROM knowledge_index_generations WHERE generation_id=? FOR UPDATE
                """, this::generationRow, generationId).getFirst();
        }
        if (!("READY".equals(generation.state()) || "RETIRED".equals(generation.state()))
                || generation.indexedCount() != generation.targetCount()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "Knowledge generation is not ready for activation.");
        }
        var configured = properties.getKnowledgeIndexing();
        if (!generation.id().equals(configured.getGenerationId())
                || !generation.configurationVersion().equals(configured.getConfigurationVersion())
                || !generation.configurationSha256().equals(configured.getConfigurationSha256())
                || !generation.tokenizerId().equals(configured.getTokenizerId())
                || !generation.collectionName().equals(configured.getCollectionName())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "Runtime knowledge generation does not match the requested generation.");
        }
        jdbc.update("""
            UPDATE knowledge_index_generations SET state='RETIRED',retired_at=CURRENT_TIMESTAMP,
                   updated_at=CURRENT_TIMESTAMP WHERE state='ACTIVE' AND generation_id<>?
            """, generationId);
        jdbc.update("""
            UPDATE knowledge_index_generations SET state='ACTIVE',activated_at=CURRENT_TIMESTAMP,
                   retired_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE generation_id=?
            """, generationId);
        return generation(generationId);
    }

    @Transactional
    public Map<String, Object> startReconciliation(String generationId, int batchSize, boolean dryRun,
            UUID requestedByUserId) {
        requireEnabled();
        if (batchSize < 1 || batchSize > 500) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                "Reconciliation batch size is outside the supported bound.");
        }
        if (jdbc.query("SELECT generation_id FROM knowledge_index_generations WHERE generation_id=?",
                (rs, row) -> rs.getString(1), generationId).isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Knowledge generation was not found.");
        }
        UUID runId = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO knowledge_reconciliation_runs(id,generation_id,batch_size,dry_run)
            VALUES (?,?,?,?)
            """, runId, generationId, batchSize, dryRun);
        return reconcile(runId, requestedByUserId);
    }

    @Transactional
    public Map<String, Object> resumeReconciliation(UUID runId, UUID requestedByUserId) {
        requireEnabled();
        return reconcile(runId, requestedByUserId);
    }

    @Transactional(readOnly = true)
    public Map<String, Object> reconciliation(UUID runId) {
        return runData(runId);
    }

    private Map<String, Object> reconcile(UUID runId, UUID requestedByUserId) {
        ReconciliationRun run = jdbc.query("""
            SELECT id,generation_id,batch_size,dry_run,state,checkpoint_source_type,
                   checkpoint_source_id,checkpoint_source_revision,scanned_count,repaired_count,finding_count
              FROM knowledge_reconciliation_runs WHERE id=? FOR UPDATE
            """, (rs, row) -> new ReconciliationRun(rs.getObject("id", UUID.class),
                rs.getString("generation_id"), rs.getInt("batch_size"), rs.getBoolean("dry_run"),
                rs.getString("state"), rs.getString("checkpoint_source_type"),
                rs.getObject("checkpoint_source_id", UUID.class),
                (Long) rs.getObject("checkpoint_source_revision"), rs.getLong("scanned_count"),
                rs.getLong("repaired_count"), rs.getLong("finding_count")), runId).stream().findFirst()
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        if (!"RUNNING".equals(run.state())) return runData(runId);

        List<WorkRow> rows = workRows(run);
        long repaired = run.repairedCount();
        long findings = run.findingCount();
        for (WorkRow work : rows) {
            var verification = worker.verifySources(List.of(new KnowledgeIndexingWorkerService.SourceVerificationRequest(
                work.sourceType(), work.sourceId(), work.meetingId(), work.sourceRevision()))).getFirst();
            String status = (String) verification.get("status");
            if ("CURRENT".equals(status) && !Set.of("RETRYABLE_FAILURE", "TERMINAL_FAILURE")
                    .contains(work.state())) {
                continue;
            }

            String findingType;
            String action;
            if ("DELETED".equals(status)) {
                findingType = "DELETED_SOURCE_POINTS";
                action = "DELETE";
            } else if (!"CURRENT".equals(status)) {
                findingType = "STALE_POINTS";
                action = "INVALIDATE";
            } else {
                findingType = "STRANDED_WORK";
                action = "RETRY";
            }
            jdbc.update("""
                INSERT INTO knowledge_reconciliation_findings(
                    id,run_id,finding_type,action,source_type,source_id,meeting_id,source_revision,
                    generation_id,detail)
                VALUES (?,?,?,?,?,?,?,?,?,CAST(? AS jsonb)) ON CONFLICT DO NOTHING
                """, UUID.randomUUID(), runId, findingType, action, work.sourceType(), work.sourceId(),
                work.meetingId(), work.sourceRevision(), work.generationId(),
                "{\"status\":\"" + status + "\",\"state\":\"" + work.state() + "\"}");
            findings++;
            if (!run.dryRun()) {
                var event = switch (action) {
                    case "DELETE" -> producer.requestDelete(work.sourceType(), work.sourceId(),
                        work.meetingId(), requestedByUserId);
                    case "INVALIDATE" -> producer.request(work.sourceType(), work.sourceId(), work.meetingId());
                    default -> producer.requestReindex(work.sourceType(), work.sourceId(), work.meetingId(),
                        work.generationId(), requestedByUserId);
                };
                if (event.isPresent()) repaired++;
            }
        }

        long scanned = run.scannedCount() + rows.size();
        if (rows.isEmpty() || rows.size() < run.batchSize()) {
            jdbc.update("""
                UPDATE knowledge_reconciliation_runs SET state='COMPLETED',scanned_count=?,repaired_count=?,
                    finding_count=?,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?
                """, scanned, repaired, findings, runId);
        } else {
            WorkRow checkpoint = rows.getLast();
            jdbc.update("""
                UPDATE knowledge_reconciliation_runs SET checkpoint_source_type=?,checkpoint_source_id=?,
                    checkpoint_source_revision=?,scanned_count=?,repaired_count=?,finding_count=?,
                    updated_at=CURRENT_TIMESTAMP WHERE id=?
                """, checkpoint.sourceType(), checkpoint.sourceId(), checkpoint.sourceRevision(), scanned,
                repaired, findings, runId);
        }
        return runData(runId);
    }

    private void refreshLocked(String generationId) {
        GenerationRow generation = jdbc.query("""
            SELECT generation_id,configuration_version,configuration_sha256,tokenizer_id,collection_name,
                   state,target_count,indexed_count
              FROM knowledge_index_generations WHERE generation_id=? FOR UPDATE
            """, this::generationRow, generationId).stream().findFirst().orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "Knowledge generation was not found."));
        if (!Set.of("PREPARING", "READY").contains(generation.state())) return;

        GenerationProgress progress = jdbc.queryForObject("""
            WITH latest AS (
                SELECT DISTINCT ON (source_type,source_id,source_revision)
                       operation,state
                  FROM knowledge_indexing_work
                 WHERE index_generation_id=?
                 ORDER BY source_type,source_id,source_revision,created_at DESC,intent_sequence DESC,event_id DESC
            )
            SELECT count(*) AS target_count,
                   count(*) FILTER (WHERE state IN
                       ('INDEXED','NO_ELIGIBLE_CONTENT','INVALIDATED','DELETED','SUPERSEDED')) AS indexed_count
              FROM latest
            """, (rs, row) -> new GenerationProgress(rs.getLong("target_count"),
                rs.getLong("indexed_count")), generationId);
        boolean ready = progress.indexedCount() == progress.targetCount();
        jdbc.update("""
            UPDATE knowledge_index_generations
               SET state=?,target_count=?,indexed_count=?,
                   ready_at=CASE WHEN ? THEN COALESCE(ready_at,CURRENT_TIMESTAMP) ELSE NULL END,
                   updated_at=CURRENT_TIMESTAMP
             WHERE generation_id=? AND state IN ('PREPARING','READY')
            """, ready ? "READY" : "PREPARING", progress.targetCount(), progress.indexedCount(), ready,
            generationId);
    }

    private GenerationRow generationRow(java.sql.ResultSet rs, int row) throws java.sql.SQLException {
        return new GenerationRow(rs.getString("generation_id"), rs.getString("configuration_version"),
            rs.getString("configuration_sha256"), rs.getString("tokenizer_id"),
            rs.getString("collection_name"), rs.getString("state"), rs.getLong("target_count"),
            rs.getLong("indexed_count"));
    }

    private List<WorkRow> workRows(ReconciliationRun run) {
        if (run.checkpointSourceType() == null) {
            return jdbc.query("""
                SELECT source_type,source_id,meeting_id,source_revision,index_generation_id,state
                  FROM knowledge_indexing_work
                 WHERE index_generation_id=? AND operation='UPSERT'
                 ORDER BY source_type,source_id,source_revision,event_id LIMIT ?
                """, this::workRow, run.generationId(), run.batchSize());
        }
        return jdbc.query("""
            SELECT source_type,source_id,meeting_id,source_revision,index_generation_id,state
              FROM knowledge_indexing_work
             WHERE index_generation_id=? AND operation='UPSERT'
               AND (source_type>? OR (source_type=? AND source_id>?)
                    OR (source_type=? AND source_id=? AND source_revision>?))
             ORDER BY source_type,source_id,source_revision,event_id LIMIT ?
            """, this::workRow, run.generationId(), run.checkpointSourceType(), run.checkpointSourceType(),
            run.checkpointSourceId(), run.checkpointSourceType(), run.checkpointSourceId(),
            run.checkpointSourceRevision(), run.batchSize());
    }

    private WorkRow workRow(java.sql.ResultSet rs, int row) throws java.sql.SQLException {
        return new WorkRow(rs.getString("source_type"), rs.getObject("source_id", UUID.class),
            rs.getObject("meeting_id", UUID.class), rs.getLong("source_revision"),
            rs.getString("index_generation_id"), rs.getString("state"));
    }

    private Map<String, Object> runData(UUID runId) {
        return jdbc.query("""
            SELECT id,generation_id,batch_size,dry_run,state,checkpoint_source_type,checkpoint_source_id,
                   checkpoint_source_revision,scanned_count,repaired_count,finding_count,last_error_code,
                   last_error_summary,started_at,completed_at,updated_at
              FROM knowledge_reconciliation_runs WHERE id=?
            """, (rs, row) -> {
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("id", rs.getObject("id", UUID.class));
                data.put("generationId", rs.getString("generation_id"));
                data.put("batchSize", rs.getInt("batch_size"));
                data.put("dryRun", rs.getBoolean("dry_run"));
                data.put("state", rs.getString("state"));
                data.put("checkpointSourceType", rs.getString("checkpoint_source_type"));
                data.put("checkpointSourceId", rs.getObject("checkpoint_source_id", UUID.class));
                data.put("checkpointSourceRevision", rs.getObject("checkpoint_source_revision"));
                data.put("scannedCount", rs.getLong("scanned_count"));
                data.put("repairedCount", rs.getLong("repaired_count"));
                data.put("findingCount", rs.getLong("finding_count"));
                data.put("lastErrorCode", rs.getString("last_error_code"));
                data.put("lastErrorSummary", rs.getString("last_error_summary"));
                data.put("startedAt", rs.getObject("started_at"));
                data.put("completedAt", rs.getObject("completed_at"));
                data.put("updatedAt", rs.getObject("updated_at"));
                return data;
            }, runId).stream().findFirst().orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
    }

    private void requireEnabled() {
        if (!properties.getKnowledgeIndexing().isEnabled()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "Knowledge indexing is disabled.");
        }
    }

    private static ResponseStatusException unavailableSource() {
        return new ResponseStatusException(HttpStatus.CONFLICT,
            "Knowledge source is not currently eligible or has no derived index work.");
    }

    private static Map<String, Object> eventData(KnowledgeIndexingEvent event) {
        return Map.of("eventId", event.eventId(), "operation", event.operation(), "reason", event.reason(),
            "sourceType", event.sourceType(), "sourceId", event.sourceId(),
            "sourceRevision", event.sourceRevision(), "indexGenerationId", event.indexGenerationId());
    }

    private record GenerationRow(String id, String configurationVersion, String configurationSha256,
            String tokenizerId, String collectionName, String state, long targetCount, long indexedCount) { }
    private record GenerationProgress(long targetCount, long indexedCount) { }
    private record ReconciliationRun(UUID id, String generationId, int batchSize, boolean dryRun,
            String state, String checkpointSourceType, UUID checkpointSourceId,
            Long checkpointSourceRevision, long scannedCount, long repairedCount, long findingCount) { }
    private record WorkRow(String sourceType, UUID sourceId, UUID meetingId, long sourceRevision,
            String generationId, String state) { }
}
