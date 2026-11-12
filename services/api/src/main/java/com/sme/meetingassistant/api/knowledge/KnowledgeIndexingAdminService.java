package com.sme.meetingassistant.api.knowledge;

import com.sme.meetingassistant.api.media.MediaProperties;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
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
    private final ObjectProvider<KnowledgeVectorAudit> vectorAudits;

    public KnowledgeIndexingAdminService(JdbcTemplate jdbc, KnowledgeIndexingProducer producer,
            KnowledgeIndexingWorkerService worker, MediaProperties properties,
            ObjectProvider<KnowledgeVectorAudit> vectorAudits) {
        this.jdbc = jdbc;
        this.producer = producer;
        this.worker = worker;
        this.properties = properties;
        this.vectorAudits = vectorAudits;
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
        // A temporary AI/Qdrant outage is not a terminal reconciliation
        // decision. Resume from the durable checkpoint, never from page zero.
        jdbc.update("""
            UPDATE knowledge_reconciliation_runs
               SET state='RUNNING',last_error_code=NULL,last_error_summary=NULL,
                   updated_at=CURRENT_TIMESTAMP
             WHERE id=? AND state='FAILED'
               AND last_error_code IN ('VECTOR_AUDIT_UNAVAILABLE','VECTOR_AUDIT_INVALID')
            """, runId);
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
        if (!rows.isEmpty()) {
            KnowledgeVectorAudit vectorAudit = vectorAudits.getIfAvailable();
            if (vectorAudit == null) {
                jdbc.update("""
                    UPDATE knowledge_reconciliation_runs SET state='FAILED',last_error_code=?,
                        last_error_summary=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
                    """, "VECTOR_AUDIT_UNAVAILABLE",
                    "AI vector audit is required before reconciliation can complete.", runId);
                return runData(runId);
            }
            List<KnowledgeVectorAudit.SourceKey> sources = rows.stream().map(work ->
                new KnowledgeVectorAudit.SourceKey(work.sourceType(), work.sourceId(), work.meetingId(),
                    work.sourceRevision())).toList();
            Map<KnowledgeVectorAudit.SourceKey, Long> pointCounts;
            try {
                pointCounts = vectorAudit.countPoints(run.generationId(), sources);
            } catch (RuntimeException error) {
                jdbc.update("""
                    UPDATE knowledge_reconciliation_runs SET state='FAILED',last_error_code=?,
                        last_error_summary=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
                    """, "VECTOR_AUDIT_UNAVAILABLE",
                    "AI vector audit could not be completed.", runId);
                return runData(runId);
            }
            if (pointCounts == null || pointCounts.size() != sources.size()
                    || sources.stream().anyMatch(source -> !pointCounts.containsKey(source))) {
                jdbc.update("""
                    UPDATE knowledge_reconciliation_runs SET state='FAILED',last_error_code=?,
                        last_error_summary=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
                    """, "VECTOR_AUDIT_INVALID",
                    "AI vector audit returned an incomplete source report.", runId);
                return runData(runId);
            }
            return reconcileRows(run, rows, pointCounts, requestedByUserId, runId);
        }
        return completeReconciliation(run, rows, run.repairedCount(), run.findingCount(), runId);
    }

    private Map<String, Object> reconcileRows(ReconciliationRun run, List<WorkRow> rows,
            Map<KnowledgeVectorAudit.SourceKey, Long> pointCounts, UUID requestedByUserId, UUID runId) {
        long repaired = run.repairedCount();
        long findings = run.findingCount();
        for (WorkRow work : rows) {
            long pointCount = pointCounts.get(new KnowledgeVectorAudit.SourceKey(work.sourceType(), work.sourceId(),
                work.meetingId(), work.sourceRevision()));
            var verification = worker.verifySources(List.of(new KnowledgeIndexingWorkerService.SourceVerificationRequest(
                work.sourceType(), work.sourceId(), work.meetingId(), work.sourceRevision()))).getFirst();
            String status = (String) verification.get("status");

            String findingType;
            String action;
            Integer expectedPointCount = work.indexedChunkCount();
            if ("CURRENT".equals(status) && work.state() == null) {
                findingType = "MISSING_WORK";
                action = "REINDEX";
            } else if ("CURRENT".equals(status) && Set.of("INDEXED", "NO_ELIGIBLE_CONTENT")
                    .contains(work.state())) {
                if (expectedPointCount != null && pointCount == expectedPointCount.longValue()) {
                    continue;
                }
                // An excess point count or an absent worker receipt cannot be
                // repaired blindly by reindexing: that might leave leaked
                // points or an unknown previous generation behind.
                findingType = pointCount == 0 ? "MISSING_POINTS" : "INCOMPLETE_POINTS";
                action = expectedPointCount == null || pointCount > expectedPointCount
                    ? "MANUAL_REVIEW" : "REINDEX";
            } else if ("CURRENT".equals(status)
                    && !Set.of("RETRYABLE_FAILURE", "TERMINAL_FAILURE", "SUPERSEDED")
                    .contains(work.state())) {
                // PENDING/CLAIMED is in-flight work, not evidence of lost data.
                continue;
            } else if ("DELETED".equals(status)) {
                findingType = "DELETED_SOURCE_POINTS";
                action = "DELETE";
            } else if (!"CURRENT".equals(status)) {
                findingType = "STALE_POINTS";
                action = "INVALIDATE";
            } else {
                findingType = "STRANDED_WORK";
                action = "RETRY";
            }
            int inserted = jdbc.update("""
                INSERT INTO knowledge_reconciliation_findings(
                    id,run_id,finding_type,action,source_type,source_id,meeting_id,source_revision,
                    generation_id,point_count,detail)
                VALUES (?,?,?,?,?,?,?,?,?,?,CAST(? AS jsonb)) ON CONFLICT DO NOTHING
                """, UUID.randomUUID(), runId, findingType, action, work.sourceType(), work.sourceId(),
                work.meetingId(), work.sourceRevision(), work.generationId(), pointCount,
                "{\"status\":\"" + status + "\",\"state\":\""
                    + (work.state() == null ? "NO_WORK" : work.state())
                    + "\",\"pointCount\":" + pointCount
                    + (expectedPointCount == null ? "" : ",\"expectedPointCount\":" + expectedPointCount) + "}");
            findings += inserted;
            if (!run.dryRun() && inserted > 0 && !"MANUAL_REVIEW".equals(action)) {
                var event = switch (action) {
                    case "DELETE" -> producer.requestDelete(work.sourceType(), work.sourceId(),
                        work.meetingId(), requestedByUserId);
                    case "INVALIDATE" -> producer.requestInvalidateRevision(work.sourceType(), work.sourceId(),
                        work.meetingId(), work.sourceRevision(), requestedByUserId);
                    default -> producer.requestReindex(work.sourceType(), work.sourceId(), work.meetingId(),
                        work.generationId(), requestedByUserId);
                };
                if (event.isPresent()) repaired++;
            }
        }

        long scanned = run.scannedCount() + rows.size();
        if (rows.isEmpty() || rows.size() < run.batchSize()) {
            return completeReconciliation(run, rows, repaired, findings, runId, scanned);
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

    private Map<String, Object> completeReconciliation(ReconciliationRun run, List<WorkRow> rows,
            long repaired, long findings, UUID runId) {
        return completeReconciliation(run, rows, repaired, findings, runId,
            run.scannedCount() + rows.size());
    }

    private Map<String, Object> completeReconciliation(ReconciliationRun run, List<WorkRow> rows,
            long repaired, long findings, UUID runId, long scanned) {
        if (rows.isEmpty() || rows.size() < run.batchSize()) {
            jdbc.update("""
                UPDATE knowledge_reconciliation_runs SET state='COMPLETED',scanned_count=?,repaired_count=?,
                    finding_count=?,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?
                """, scanned, repaired, findings, runId);
            return runData(runId);
        }
        WorkRow checkpoint = rows.getLast();
        jdbc.update("""
            UPDATE knowledge_reconciliation_runs SET checkpoint_source_type=?,checkpoint_source_id=?,
                checkpoint_source_revision=?,scanned_count=?,repaired_count=?,finding_count=?,
                updated_at=CURRENT_TIMESTAMP WHERE id=?
            """, checkpoint.sourceType(), checkpoint.sourceId(), checkpoint.sourceRevision(), scanned,
            repaired, findings, runId);
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
            WITH eligible_sources AS (
                SELECT 'TRANSCRIPT' AS source_type,t.id AS source_id,t.meeting_id,
                       t.content_revision AS source_revision
                  FROM transcripts t
                 WHERE t.is_current
                   AND t.status IN ('READY','READY_WITH_WARNINGS')
                   AND t.finalized_at IS NOT NULL
                   AND EXISTS (SELECT 1 FROM transcript_segments s WHERE s.transcript_id=t.id)
                UNION ALL
                SELECT 'SUMMARY',s.id,s.meeting_id,s.version_number
                  FROM meeting_summary_versions s
                  JOIN transcripts current_source
                    ON current_source.meeting_id=s.meeting_id AND current_source.is_current
                   AND current_source.id=s.transcript_id
                   AND current_source.content_revision=s.content_revision
                 WHERE s.is_current
                   AND s.quality_status IN ('READY','READY_WITH_WARNINGS')
                   AND current_source.status IN ('READY','READY_WITH_WARNINGS')
                UNION ALL
                SELECT 'DECISION',d.id,d.meeting_id,d.version
                  FROM meeting_decisions d
                  LEFT JOIN transcripts current_source
                    ON current_source.meeting_id=d.meeting_id AND current_source.is_current
                 WHERE d.status='CONFIRMED'
                   AND (d.transcript_id IS NULL OR
                        (current_source.id=d.transcript_id
                         AND current_source.content_revision=d.content_revision
                         AND current_source.status IN ('READY','READY_WITH_WARNINGS')))
                UNION ALL
                SELECT 'ACTION_ITEM',a.id,a.meeting_id,a.version
                  FROM action_items a
                 WHERE (a.source_type='MANUAL' OR a.confirmed_by_user_id IS NOT NULL)
                   AND a.status<>'PROPOSED'
            ), latest_work AS (
                SELECT DISTINCT ON (source_type,source_id,meeting_id,source_revision)
                       source_type,source_id,meeting_id,source_revision,operation,state
                  FROM knowledge_indexing_work
                 WHERE index_generation_id=?
                 ORDER BY source_type,source_id,meeting_id,source_revision,
                          created_at DESC,intent_sequence DESC,event_id DESC
            ), targets AS (
                SELECT e.source_type,e.source_id,e.meeting_id,e.source_revision,
                       w.operation,w.state,TRUE AS eligible
                  FROM eligible_sources e
                  LEFT JOIN latest_work w
                    ON w.source_type=e.source_type AND w.source_id=e.source_id
                   AND w.meeting_id=e.meeting_id AND w.source_revision=e.source_revision
                UNION ALL
                SELECT w.source_type,w.source_id,w.meeting_id,w.source_revision,
                       w.operation,w.state,FALSE AS eligible
                  FROM latest_work w
                 WHERE NOT EXISTS (
                     SELECT 1 FROM eligible_sources e
                      WHERE e.source_type=w.source_type AND e.source_id=w.source_id
                        AND e.meeting_id=w.meeting_id AND e.source_revision=w.source_revision)
            )
            SELECT count(*) AS target_count,
                   count(*) FILTER (WHERE
                       (eligible AND operation='UPSERT' AND state IN ('INDEXED','NO_ELIGIBLE_CONTENT'))
                       OR (NOT eligible AND state IN
                           ('INDEXED','NO_ELIGIBLE_CONTENT','INVALIDATED','DELETED','SUPERSEDED'))) AS indexed_count
              FROM targets
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

    /**
     * Enumerate the UNION of canonical eligible sources and latest UPSERT work.
     * Scanning only existing work would falsely complete a run if an event had
     * never been written. The same stable keyset handles missing work and old
     * work for superseded/deleted revisions without double-counting retries.
     */
    private List<WorkRow> workRows(ReconciliationRun run) {
        String inventory = """
            WITH eligible_sources AS (
                SELECT 'TRANSCRIPT' AS source_type,t.id AS source_id,t.meeting_id,
                       t.content_revision AS source_revision
                  FROM transcripts t
                 WHERE t.is_current AND t.status IN ('READY','READY_WITH_WARNINGS')
                   AND t.finalized_at IS NOT NULL
                   AND EXISTS (SELECT 1 FROM transcript_segments s WHERE s.transcript_id=t.id)
                UNION ALL
                SELECT 'SUMMARY',s.id,s.meeting_id,s.version_number
                  FROM meeting_summary_versions s
                  JOIN transcripts t ON t.meeting_id=s.meeting_id AND t.is_current
                   AND t.id=s.transcript_id AND t.content_revision=s.content_revision
                 WHERE s.is_current AND s.quality_status IN ('READY','READY_WITH_WARNINGS')
                   AND t.status IN ('READY','READY_WITH_WARNINGS')
                UNION ALL
                SELECT 'DECISION',d.id,d.meeting_id,d.version
                  FROM meeting_decisions d
                  LEFT JOIN transcripts t ON t.meeting_id=d.meeting_id AND t.is_current
                 WHERE d.status='CONFIRMED'
                   AND (d.transcript_id IS NULL OR
                       (t.id=d.transcript_id AND t.content_revision=d.content_revision
                        AND t.status IN ('READY','READY_WITH_WARNINGS')))
                UNION ALL
                SELECT 'ACTION_ITEM',a.id,a.meeting_id,a.version
                  FROM action_items a
                 WHERE (a.source_type='MANUAL' OR a.confirmed_by_user_id IS NOT NULL)
                   AND a.status<>'PROPOSED'
            ), latest_work AS (
                SELECT DISTINCT ON (source_type,source_id,meeting_id,source_revision)
                       source_type,source_id,meeting_id,source_revision,
                       index_generation_id,state,indexed_chunk_count
                  FROM knowledge_indexing_work
                 WHERE index_generation_id=? AND operation='UPSERT'
                 ORDER BY source_type,source_id,meeting_id,source_revision,
                          intent_sequence DESC,created_at DESC,event_id DESC
            ), inventory AS (
                SELECT COALESCE(e.source_type,w.source_type) AS source_type,
                       COALESCE(e.source_id,w.source_id) AS source_id,
                       COALESCE(e.meeting_id,w.meeting_id) AS meeting_id,
                       COALESCE(e.source_revision,w.source_revision) AS source_revision,
                       COALESCE(w.index_generation_id,?) AS index_generation_id,
                       w.state,w.indexed_chunk_count
                  FROM eligible_sources e FULL OUTER JOIN latest_work w
                    ON e.source_type=w.source_type AND e.source_id=w.source_id
                   AND e.meeting_id=w.meeting_id AND e.source_revision=w.source_revision
            )
            SELECT source_type,source_id,meeting_id,source_revision,
                   index_generation_id,state,indexed_chunk_count
              FROM inventory
            """;
        if (run.checkpointSourceType() == null) {
            return jdbc.query(inventory + """
                 ORDER BY source_type,source_id,source_revision LIMIT ?
                """, this::workRow, run.generationId(), run.generationId(), run.batchSize());
        }
        return jdbc.query(inventory + """
             WHERE (source_type,source_id,source_revision) >
                   (CAST(? AS VARCHAR),CAST(? AS UUID),CAST(? AS BIGINT))
             ORDER BY source_type,source_id,source_revision LIMIT ?
            """, this::workRow, run.generationId(), run.generationId(), run.checkpointSourceType(),
            run.checkpointSourceId(), run.checkpointSourceRevision(), run.batchSize());
    }

    private WorkRow workRow(java.sql.ResultSet rs, int row) throws java.sql.SQLException {
        return new WorkRow(rs.getString("source_type"), rs.getObject("source_id", UUID.class),
            rs.getObject("meeting_id", UUID.class), rs.getLong("source_revision"),
            rs.getString("index_generation_id"), rs.getString("state"),
            (Integer) rs.getObject("indexed_chunk_count"));
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
            String generationId, String state, Integer indexedChunkCount) { }
}
