package com.sme.meetingassistant.api.knowledge;

import com.sme.meetingassistant.api.media.MediaProperties;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;

/** Administrator-only knowledge repair, generation barrier, and activation controls. */
@Service
public class KnowledgeIndexingAdminService {
    private final JdbcTemplate jdbc;
    private final KnowledgeIndexingProducer producer;
    private final MediaProperties properties;
    private final KnowledgeReconciliationService reconciliation;

    public KnowledgeIndexingAdminService(JdbcTemplate jdbc, KnowledgeIndexingProducer producer,
            MediaProperties properties, KnowledgeReconciliationService reconciliation) {
        this.jdbc = jdbc;
        this.producer = producer;
        this.properties = properties;
        this.reconciliation = reconciliation;
    }

    @Transactional
    public Map<String, Object> reindex(String sourceType, UUID sourceId, UUID meetingId,
            String generationId, UUID requestedByUserId) {
        requireEnabled();
        KnowledgeIndexingEvent event = producer.requestReindex(sourceType, sourceId, meetingId,
            generationId, requestedByUserId).orElseThrow(KnowledgeIndexingAdminService::unavailableSource);
        return eventData(event);
    }

    @Transactional
    public Map<String, Object> delete(String sourceType, UUID sourceId, UUID meetingId,
            UUID requestedByUserId) {
        requireEnabled();
        KnowledgeIndexingEvent event = producer.requestDelete(sourceType, sourceId, meetingId,
            requestedByUserId).orElseThrow(KnowledgeIndexingAdminService::unavailableSource);
        return eventData(event);
    }

    @Transactional(readOnly = true)
    public Map<String, Object> generation(String generationId) {
        return jdbc.query("""
            SELECT generation_id,configuration_version,configuration_sha256,tokenizer_id,
                   collection_name,state,target_count,indexed_count,checkpoint_source_type,
                   checkpoint_source_id,last_error_code,last_error_summary,prepared_at,ready_at,
                   activated_at,retired_at,created_at,updated_at,write_epoch,
                   write_barrier_state,seal_id,sealed_epoch,sealed_at
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
                data.put("writeEpoch", rs.getLong("write_epoch"));
                data.put("writeBarrierState", rs.getString("write_barrier_state"));
                data.put("sealId", rs.getObject("seal_id", UUID.class));
                data.put("sealedEpoch", rs.getObject("sealed_epoch"));
                data.put("sealedAt", rs.getObject("sealed_at"));
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
                   state,target_count,indexed_count,write_epoch,write_barrier_state,seal_id,sealed_epoch
              FROM knowledge_index_generations WHERE generation_id=? FOR UPDATE
            """, this::generationRow, generationId);
        if (!existing.isEmpty()) {
            GenerationRow row = existing.getFirst();
            if (!row.configurationVersion().equals(configurationVersion)
                    || !row.configurationSha256().equals(configurationSha256)
                    || !row.tokenizerId().equals(tokenizerId)
                    || !row.collectionName().equals(collectionName)) {
                throw conflict("Knowledge generation identity is immutable.");
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

    /** Create a unique durable seal after all application-controlled writers are drained. */
    @Transactional
    public Map<String, Object> seal(String generationId) {
        requireEnabled();
        GenerationRow generation = lockGeneration(generationId);
        if ("SEALED".equals(generation.barrierState())) return generation(generationId);
        if (!"READY".equals(generation.state()) || generation.targetCount() != generation.indexedCount()) {
            throw conflict("GENERATION_NOT_READY_FOR_SEAL");
        }
        if (liveClaim(generationId)) throw conflict("WORKER_CLAIM_ACTIVE");
        Boolean openPermit = jdbc.queryForObject("""
            SELECT EXISTS(SELECT 1 FROM knowledge_qdrant_write_permits
                WHERE generation_id=? AND state='OPEN')
            """, Boolean.class, generationId);
        if (Boolean.TRUE.equals(openPermit)) throw conflict("QDRANT_PERMIT_OPEN");
        Boolean unresolvedWork = jdbc.queryForObject("""
            SELECT EXISTS(SELECT 1 FROM knowledge_indexing_work
                WHERE index_generation_id=?
                  AND state NOT IN ('INDEXED','INVALIDATED','DELETED','SUPERSEDED','NO_ELIGIBLE_CONTENT'))
            """, Boolean.class, generationId);
        if (Boolean.TRUE.equals(unresolvedWork)) throw conflict("INDEXING_WORK_UNRESOLVED");

        UUID sealId = UUID.randomUUID();
        jdbc.update("""
            UPDATE knowledge_index_generations
               SET write_barrier_state='SEALED',seal_id=?,sealed_epoch=write_epoch,
                   sealed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
             WHERE generation_id=? AND state='READY' AND write_barrier_state='OPEN'
            """, sealId, generationId);
        return generation(generationId);
    }

    /** Explicit repair release. It advances the epoch so no old certification can be reused. */
    @Transactional
    public Map<String, Object> unseal(String generationId) {
        requireEnabled();
        GenerationRow generation = lockGeneration(generationId);
        if (!"SEALED".equals(generation.barrierState())) return generation(generationId);
        if ("ACTIVE".equals(generation.state())) throw conflict("ACTIVE_GENERATION_CANNOT_BE_UNSEALED");
        jdbc.update("""
            UPDATE knowledge_index_generations
               SET write_epoch=write_epoch+1,write_barrier_state='OPEN',seal_id=NULL,
                   sealed_epoch=NULL,sealed_at=NULL,updated_at=CURRENT_TIMESTAMP
             WHERE generation_id=?
            """, generationId);
        jdbc.update("""
            UPDATE knowledge_reconciliation_runs
               SET state='FAILED',inventory_complete=FALSE,last_error_code='CERTIFICATION_STALE',
                   last_error_summary='Administrative unseal invalidated certification evidence.',
                   claim_token=NULL,claim_expires_at=NULL,updated_at=CURRENT_TIMESTAMP
             WHERE generation_id=? AND certification_mode='CERTIFICATION'
               AND state IN ('RUNNING','PAUSED','COMPLETED')
            """, generationId);
        return generation(generationId);
    }

    @Transactional
    public Map<String, Object> activate(String generationId) {
        requireEnabled();
        GenerationRow generation = lockGeneration(generationId);
        if ("ACTIVE".equals(generation.state())) return generation(generationId);
        if ("PREPARING".equals(generation.state())
                || "READY".equals(generation.state()) && "OPEN".equals(generation.barrierState())) {
            refreshLocked(generationId);
            generation = lockGeneration(generationId);
        }
        if (!("READY".equals(generation.state()) || "RETIRED".equals(generation.state()))
                || generation.indexedCount() != generation.targetCount()) {
            throw conflict("Knowledge generation is not ready for activation.");
        }
        if ("READY".equals(generation.state())) {
            if (!"SEALED".equals(generation.barrierState()) || generation.sealId() == null
                    || generation.sealedEpoch() == null || generation.sealedEpoch() != generation.writeEpoch()) {
                throw conflict("Knowledge generation requires a current durable seal.");
            }
            Boolean cleanCertification = jdbc.queryForObject("""
                SELECT EXISTS(
                    SELECT 1 FROM knowledge_reconciliation_runs
                     WHERE generation_id=? AND certification_mode='CERTIFICATION'
                       AND certification_seal_id=? AND certification_epoch=?
                       AND state='COMPLETED' AND dry_run AND inventory_complete
                       AND finding_count=0 AND repaired_count=0)
                """, Boolean.class, generationId, generation.sealId(), generation.writeEpoch());
            if (!Boolean.TRUE.equals(cleanCertification)) {
                throw conflict("Knowledge generation requires clean current certification.");
            }
            Boolean openPermit = jdbc.queryForObject("""
                SELECT EXISTS(SELECT 1 FROM knowledge_qdrant_write_permits
                    WHERE generation_id=? AND state='OPEN')
                """, Boolean.class, generationId);
            if (Boolean.TRUE.equals(openPermit) || liveClaim(generationId)) {
                throw conflict("Knowledge generation still has an unaccounted worker operation.");
            }
        }
        var configured = properties.getKnowledgeIndexing();
        if (!generation.id().equals(configured.getGenerationId())
                || !generation.configurationVersion().equals(configured.getConfigurationVersion())
                || !generation.configurationSha256().equals(configured.getConfigurationSha256())
                || !generation.tokenizerId().equals(configured.getTokenizerId())
                || !generation.collectionName().equals(configured.getCollectionName())) {
            throw conflict("Runtime knowledge generation does not match the requested generation.");
        }
        jdbc.update("""
            UPDATE knowledge_index_generations SET state='RETIRED',retired_at=CURRENT_TIMESTAMP,
                   updated_at=CURRENT_TIMESTAMP WHERE state='ACTIVE' AND generation_id<>?
            """, generationId);
        // Candidate activation and barrier release are one database commit. The
        // seal audit trigger records the release without resurrecting its ID.
        jdbc.update("""
            UPDATE knowledge_index_generations SET state='ACTIVE',activated_at=CURRENT_TIMESTAMP,
                   retired_at=NULL,write_barrier_state='OPEN',seal_id=NULL,sealed_epoch=NULL,
                   sealed_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE generation_id=?
            """, generationId);
        return generation(generationId);
    }

    public Map<String, Object> startReconciliation(String generationId, int batchSize, boolean dryRun,
            UUID requestedByUserId) {
        requireEnabled();
        return reconciliation.start(generationId, batchSize, dryRun, "OPERATIONAL", requestedByUserId);
    }

    public Map<String, Object> startReconciliation(String generationId, int batchSize, boolean dryRun,
            String certificationMode, UUID requestedByUserId) {
        requireEnabled();
        if ("CERTIFICATION".equals(certificationMode)) {
            return reconciliation.start(generationId, batchSize, true, "CERTIFICATION", requestedByUserId);
        }
        return reconciliation.start(generationId, batchSize, dryRun, "OPERATIONAL", requestedByUserId);
    }

    public Map<String, Object> startCertification(String generationId, int batchSize,
            UUID requestedByUserId) {
        requireEnabled();
        return reconciliation.start(generationId, batchSize, true, "CERTIFICATION", requestedByUserId);
    }

    public Map<String, Object> resumeReconciliation(UUID runId, UUID requestedByUserId) {
        requireEnabled();
        return reconciliation.resume(runId, requestedByUserId);
    }

    public Map<String, Object> reconciliation(UUID runId) {
        return reconciliation.read(runId);
    }

    private GenerationRow lockGeneration(String generationId) {
        return jdbc.query("""
            SELECT generation_id,configuration_version,configuration_sha256,tokenizer_id,collection_name,
                   state,target_count,indexed_count,write_epoch,write_barrier_state,seal_id,sealed_epoch
              FROM knowledge_index_generations WHERE generation_id=? FOR UPDATE
            """, this::generationRow, generationId).stream().findFirst().orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Knowledge generation was not found."));
    }

    private boolean liveClaim(String generationId) {
        return Boolean.TRUE.equals(jdbc.queryForObject("""
            SELECT EXISTS(SELECT 1 FROM knowledge_indexing_work
                WHERE index_generation_id=? AND state='CLAIMED'
                  AND claim_expires_at>CURRENT_TIMESTAMP)
            """, Boolean.class, generationId));
    }

    private void refreshLocked(String generationId) {
        GenerationRow generation = lockGeneration(generationId);
        if (!Set.of("PREPARING", "READY").contains(generation.state())) return;
        if ("SEALED".equals(generation.barrierState())) throw conflict("SEALED_GENERATION_REQUIRES_CERTIFICATION");
        GenerationProgress progress = jdbc.queryForObject("""
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
                  JOIN transcripts current_source
                    ON current_source.meeting_id=s.meeting_id AND current_source.is_current
                   AND current_source.id=s.transcript_id
                   AND current_source.content_revision=s.content_revision
                 WHERE s.is_current AND s.quality_status IN ('READY','READY_WITH_WARNINGS')
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
                 WHERE NOT EXISTS(
                     SELECT 1 FROM eligible_sources e
                      WHERE e.source_type=w.source_type AND e.source_id=w.source_id
                        AND e.meeting_id=w.meeting_id AND e.source_revision=w.source_revision)
            )
            SELECT count(*) AS target_count,
                   count(*) FILTER (WHERE
                       (eligible AND operation='UPSERT' AND state IN ('INDEXED','NO_ELIGIBLE_CONTENT'))
                       OR (NOT eligible AND state IN ('INVALIDATED','DELETED','SUPERSEDED'))) AS indexed_count
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
            rs.getLong("indexed_count"), rs.getLong("write_epoch"),
            rs.getString("write_barrier_state"), rs.getObject("seal_id", UUID.class),
            rs.getObject("sealed_epoch", Long.class));
    }

    private void requireEnabled() {
        if (!properties.getKnowledgeIndexing().isEnabled()) {
            throw conflict("Knowledge indexing is disabled.");
        }
    }

    private static ResponseStatusException conflict(String message) {
        return new ResponseStatusException(HttpStatus.CONFLICT, message);
    }

    private static ResponseStatusException unavailableSource() {
        return conflict("Knowledge source is not currently eligible or has no derived index work.");
    }

    private static Map<String, Object> eventData(KnowledgeIndexingEvent event) {
        return Map.of("eventId", event.eventId(), "operation", event.operation(), "reason", event.reason(),
            "sourceType", event.sourceType(), "sourceId", event.sourceId(),
            "sourceRevision", event.sourceRevision(), "indexGenerationId", event.indexGenerationId());
    }

    private record GenerationRow(String id, String configurationVersion, String configurationSha256,
            String tokenizerId, String collectionName, String state, long targetCount, long indexedCount,
            long writeEpoch, String barrierState, UUID sealId, Long sealedEpoch) { }
    private record GenerationProgress(long targetCount, long indexedCount) { }
}
