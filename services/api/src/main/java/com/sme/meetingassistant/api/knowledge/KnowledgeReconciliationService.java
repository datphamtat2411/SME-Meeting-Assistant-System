package com.sme.meetingassistant.api.knowledge;

import com.sme.meetingassistant.api.media.MediaProperties;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/**
 * Fenced reconciliation orchestration. Claim and acceptance transactions are
 * deliberately short; the AI/Qdrant boundary is called only between them.
 */
@Service
public class KnowledgeReconciliationService {
    private final JdbcTemplate jdbc;
    private final KnowledgeIndexingProducer producer;
    private final KnowledgeIndexingWorkerService worker;
    private final MediaProperties properties;
    private final KnowledgeVectorAudit vectorAudit;
    private final TransactionTemplate transaction;

    public KnowledgeReconciliationService(JdbcTemplate jdbc, KnowledgeIndexingProducer producer,
            KnowledgeIndexingWorkerService worker, MediaProperties properties,
            org.springframework.beans.factory.ObjectProvider<KnowledgeVectorAudit> vectorAudits,
            PlatformTransactionManager transactionManager) {
        this.jdbc = jdbc;
        this.producer = producer;
        this.worker = worker;
        this.properties = properties;
        this.vectorAudit = vectorAudits.getIfAvailable();
        this.transaction = new TransactionTemplate(transactionManager);
        this.transaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        this.transaction.setTimeout(30);
    }

    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public Map<String, Object> start(String generationId, int batchSize, boolean dryRun,
            String certificationMode, UUID requestedByUserId) {
        if (batchSize < 1 || batchSize > 500) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.UNPROCESSABLE_ENTITY,
                "Reconciliation batch size is outside the supported bound.");
        }
        String mode = certificationMode == null || certificationMode.isBlank()
            ? "OPERATIONAL" : certificationMode;
        UUID runId = transaction.execute(status -> createRun(generationId, batchSize, dryRun, mode));
        return executeBoundary(runId, requestedByUserId);
    }

    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public Map<String, Object> resume(UUID runId, UUID requestedByUserId) {
        transaction.executeWithoutResult(status -> resumeLocked(runId));
        return executeBoundary(runId, requestedByUserId);
    }

    public Map<String, Object> read(UUID runId) {
        return runData(runId);
    }

    private UUID createRun(String generationId, int batchSize, boolean dryRun, String mode) {
        Generation generation = lockGeneration(generationId);
        if ("CERTIFICATION".equals(mode)) {
            if (!dryRun || !"READY".equals(generation.state())
                    || !"SEALED".equals(generation.barrierState())
                    || generation.sealId() == null
                    || generation.sealedEpoch() == null
                    || generation.sealedEpoch() != generation.writeEpoch()
                    || generation.targetCount() != generation.indexedCount()) {
                throw conflict("CERTIFICATION_REQUIRES_CURRENT_SEALED_READY_GENERATION");
            }
        } else if (!"OPERATIONAL".equals(mode)) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.UNPROCESSABLE_ENTITY,
                "Unsupported reconciliation mode.");
        } else if ("SEALED".equals(generation.barrierState())) {
            throw conflict("SEALED_GENERATION_REQUIRES_CERTIFICATION");
        }
        UUID runId = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO knowledge_reconciliation_runs(
                id,generation_id,batch_size,dry_run,certification_mode,
                certification_seal_id,certification_epoch)
            VALUES (?,?,?,?,?,?,?)
            """, runId, generationId, batchSize, dryRun, mode,
            "CERTIFICATION".equals(mode) ? generation.sealId() : null,
            "CERTIFICATION".equals(mode) ? generation.writeEpoch() : null);
        return runId;
    }

    private void resumeLocked(UUID runId) {
        Run run = lockRun(runId);
        if (!"FAILED".equals(run.state()) || !Set.of(
                "VECTOR_AUDIT_UNAVAILABLE", "VECTOR_AUDIT_INVALID", "VECTOR_CURSOR_INVALID",
                "VECTOR_GENERATION_MISMATCH", "RECONCILIATION_CLAIM_EXPIRED")
                .contains(run.lastErrorCode())) {
            return;
        }
        Generation generation = lockGeneration(run.generationId());
        if ("CERTIFICATION".equals(run.certificationMode())
                && (!"SEALED".equals(generation.barrierState())
                    || !Objects.equals(run.certificationSealId(), generation.sealId())
                    || !Objects.equals(run.certificationEpoch(), generation.writeEpoch()))) {
            throw conflict("CERTIFICATION_SEAL_STALE");
        }
        jdbc.update("""
            UPDATE knowledge_reconciliation_runs
               SET state='RUNNING',last_error_code=NULL,last_error_summary=NULL,
                   inventory_complete=FALSE,updated_at=CURRENT_TIMESTAMP
             WHERE id=? AND state='FAILED'
            """, runId);
    }

    /** Keep the API-compatible behavior of completing a final source page and one vector page. */
    private Map<String, Object> executeBoundary(UUID runId, UUID requestedByUserId) {
        Map<String, Object> result = executePage(runId, requestedByUserId);
        if ("RUNNING".equals(result.get("state")) && "VECTORS".equals(result.get("phase"))
                && "SOURCES".equals(result.get("acceptedPhase"))) {
            result = executePage(runId, requestedByUserId);
        }
        return result;
    }

    private Map<String, Object> executePage(UUID runId, UUID requestedByUserId) {
        PageClaim claim = transaction.execute(status -> claimPage(runId));
        if (claim == null) return runData(runId);

        if (claim.phase().equals("SOURCES") && claim.rows().isEmpty()) {
            return acceptSource(claim, Map.of(), requestedByUserId);
        }
        if (claim.phase().equals("SOURCES")) {
            if (vectorAudit == null) return fail(claim, "VECTOR_AUDIT_UNAVAILABLE");
            try {
                List<KnowledgeVectorAudit.SourceKey> sources = claim.rows().stream().map(this::sourceKey).toList();
                Map<KnowledgeVectorAudit.SourceKey, Long> counts = vectorAudit.countPoints(
                    claim.generationId(), sources);
                if (!completeSourceCounts(counts, sources)) return fail(claim, "VECTOR_AUDIT_INVALID");
                return acceptSource(claim, counts, requestedByUserId);
            } catch (RuntimeException failure) {
                return fail(claim, failure instanceof AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException audit
                    ? audit.reconciliationCode() : "VECTOR_AUDIT_UNAVAILABLE");
            }
        }

        if (vectorAudit == null) return fail(claim, "VECTOR_AUDIT_UNAVAILABLE");
        try {
            KnowledgeVectorAudit.InventoryPage page = vectorAudit.inventoryPage(
                claim.generationId(), claim.vectorCursor(), claim.batchSize());
            validateInventoryPage(page, claim.vectorCursor(), claim.batchSize());
            return acceptVector(claim, page, requestedByUserId);
        } catch (AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException failure) {
            return fail(claim, failure.reconciliationCode());
        } catch (InvalidAuditResponse failure) {
            return fail(claim, "VECTOR_AUDIT_INVALID");
        } catch (RuntimeException failure) {
            return fail(claim, "VECTOR_AUDIT_UNAVAILABLE");
        }
    }

    private PageClaim claimPage(UUID runId) {
        Run run = lockRun(runId);
        if (!"RUNNING".equals(run.state())) return null;
        if (run.claimToken() != null) {
            OffsetDateTime now = jdbc.queryForObject("SELECT CURRENT_TIMESTAMP", OffsetDateTime.class);
            if (run.claimExpiresAt() != null && run.claimExpiresAt().isAfter(now)) return null;
            clearClaim(runId);
            run = lockRun(runId);
        }
        Generation generation = lockGeneration(run.generationId());
        if ("CERTIFICATION".equals(run.certificationMode())
                && (!Objects.equals(run.certificationEpoch(), generation.writeEpoch())
                    || !Objects.equals(run.certificationSealId(), generation.sealId())
                    || !"SEALED".equals(generation.barrierState()))) {
            failLocked(runId, "CERTIFICATION_STALE");
            return null;
        }
        if ("CERTIFICATION".equals(run.certificationMode())
                && !"SEALED".equals(generation.barrierState())) {
            failLocked(runId, "CERTIFICATION_STALE");
            return null;
        }
        if ("OPERATIONAL".equals(run.certificationMode())
                && "SEALED".equals(generation.barrierState())) {
            failLocked(runId, "SEALED_GENERATION_REQUIRES_CERTIFICATION");
            return null;
        }

        int claimSeconds = properties.getKnowledgeIndexing().getReconciliationClaimSeconds();
        if (claimSeconds < 30 || claimSeconds > 900) {
            throw new IllegalStateException("Invalid reconciliation claim lease");
        }
        List<WorkRow> rows = "SOURCES".equals(run.phase()) ? workRows(run) : List.of();
        String cursor = null;
        if ("VECTORS".equals(run.phase())) {
            try {
                cursor = InventoryCursor.normalize(run.vectorCursor());
            } catch (IllegalArgumentException invalid) {
                failLocked(runId, "VECTOR_CURSOR_INVALID");
                return null;
            }
        }
        UUID token = UUID.randomUUID();
        jdbc.update("""
            UPDATE knowledge_reconciliation_runs
               SET claim_token=?,claim_expires_at=CURRENT_TIMESTAMP + (? * INTERVAL '1 second'),
                   expected_generation_epoch=?,expected_seal_id=?,expected_phase=?,
                   expected_checkpoint_source_type=?,expected_checkpoint_source_id=?,
                   expected_checkpoint_source_revision=?,expected_vector_cursor=?,
                   claim_attempt=claim_attempt+1,updated_at=CURRENT_TIMESTAMP
             WHERE id=? AND state='RUNNING' AND claim_token IS NULL
            """, token, claimSeconds, generation.writeEpoch(),
            "CERTIFICATION".equals(run.certificationMode()) ? generation.sealId() : null,
            run.phase(), run.checkpointSourceType(), run.checkpointSourceId(),
            run.checkpointSourceRevision(), cursor, runId);
        return new PageClaim(runId, run.generationId(), run.batchSize(), run.dryRun(),
            run.certificationMode(), token, generation.writeEpoch(), generation.sealId(), run.phase(),
            run.checkpointSourceType(), run.checkpointSourceId(), run.checkpointSourceRevision(), cursor,
            rows);
    }

    private Map<String, Object> acceptSource(PageClaim claim,
            Map<KnowledgeVectorAudit.SourceKey, Long> pointCounts, UUID requestedByUserId) {
        Map<String, Object> result = transaction.execute(status -> {
            Run run = lockRun(claim.runId());
            if (!acceptanceFence(run, claim)) return runData(claim.runId());
            lockMeetings(claim.rows());
            Generation generation = lockGeneration(claim.generationId());
            if (!fenceGeneration(run, generation)) return staleLocked(run, claim);

            long findings = run.findingCount();
            long repaired = run.repairedCount();
            for (WorkRow workRow : claim.rows()) {
                KnowledgeVectorAudit.SourceKey source = sourceKey(workRow);
                Long pointCount = pointCounts.get(source);
                if (pointCount == null || pointCount < 0) throw new InvalidAuditResponse();
                var verification = worker.verifySources(List.of(
                    new KnowledgeIndexingWorkerService.SourceVerificationRequest(
                        workRow.sourceType(), workRow.sourceId(), workRow.meetingId(), workRow.sourceRevision())))
                    .getFirst();
                String sourceStatus = (String) verification.get("status");
                Finding finding = findingFor(workRow, pointCount, sourceStatus);
                if (finding == null) continue;
                int inserted = insertFinding(claim.runId(), finding, workRow, pointCount, sourceStatus);
                findings += inserted;
                if (inserted > 0 && !claim.dryRun() && !"CERTIFICATION".equals(claim.certificationMode())
                        && !"MANUAL_REVIEW".equals(finding.action())) {
                    var event = switch (finding.action()) {
                        case "DELETE", "INVALIDATE" -> producer.requestReconcileLifecycle(
                            workRow.sourceType(), workRow.sourceId(), workRow.meetingId(),
                            workRow.sourceRevision(), workRow.generationId(), finding.action(), requestedByUserId);
                        default -> producer.requestReindex(workRow.sourceType(), workRow.sourceId(),
                            workRow.meetingId(), workRow.generationId(), requestedByUserId);
                    };
                    if (event.isPresent()) repaired++;
                }
            }
            long scanned = run.scannedCount() + claim.rows().size();
            if (claim.rows().size() < run.batchSize()) {
                updateSourceCompletion(claim, scanned, repaired, findings);
            } else {
                WorkRow checkpoint = claim.rows().getLast();
                jdbc.update("""
                    UPDATE knowledge_reconciliation_runs
                       SET checkpoint_source_type=?,checkpoint_source_id=?,checkpoint_source_revision=?,
                           scanned_count=?,repaired_count=?,finding_count=?,
                           claim_token=NULL,claim_expires_at=NULL,expected_generation_epoch=NULL,
                           expected_seal_id=NULL,expected_phase=NULL,expected_checkpoint_source_type=NULL,
                           expected_checkpoint_source_id=NULL,expected_checkpoint_source_revision=NULL,
                           expected_vector_cursor=NULL,updated_at=CURRENT_TIMESTAMP
                     WHERE id=?
                    """, checkpoint.sourceType(), checkpoint.sourceId(), checkpoint.sourceRevision(),
                    scanned, repaired, findings, claim.runId());
            }
            Map<String, Object> data = runData(claim.runId());
            data.put("acceptedPhase", "SOURCES");
            return data;
        });
        return result;
    }

    private void updateSourceCompletion(PageClaim claim, long scanned, long repaired, long findings) {
        jdbc.update("""
            UPDATE knowledge_reconciliation_runs
               SET phase='VECTORS',scanned_count=?,repaired_count=?,finding_count=?,
                   claim_token=NULL,claim_expires_at=NULL,expected_generation_epoch=NULL,
                   expected_seal_id=NULL,expected_phase=NULL,expected_checkpoint_source_type=NULL,
                   expected_checkpoint_source_id=NULL,expected_checkpoint_source_revision=NULL,
                   expected_vector_cursor=NULL,updated_at=CURRENT_TIMESTAMP
             WHERE id=?
            """, scanned, repaired, findings, claim.runId());
    }

    private Map<String, Object> acceptVector(PageClaim claim, KnowledgeVectorAudit.InventoryPage page,
            UUID requestedByUserId) {
        return transaction.execute(status -> {
            Run run = lockRun(claim.runId());
            if (!acceptanceFence(run, claim)) return runData(claim.runId());
            List<WorkRow> observed = page.sources().stream().distinct().map(source ->
                new WorkRow(source.sourceType(), source.sourceId(), source.meetingId(), source.sourceRevision(),
                    claim.generationId(), null, null)).toList();
            lockMeetings(observed);
            Generation generation = lockGeneration(claim.generationId());
            if (!fenceGeneration(run, generation)) return staleLocked(run, claim);

            long findings = run.findingCount();
            for (KnowledgeVectorAudit.SourceKey source : page.sources().stream().distinct().toList()) {
                boolean hasWork = Boolean.TRUE.equals(jdbc.queryForObject("""
                    SELECT EXISTS(SELECT 1 FROM knowledge_indexing_work
                     WHERE index_generation_id=? AND source_type=? AND source_id=?
                       AND meeting_id=? AND source_revision=? AND operation='UPSERT')
                    """, Boolean.class, claim.generationId(), source.sourceType(), source.sourceId(),
                    source.meetingId(), source.sourceRevision()));
                if (hasWork) continue;
                var verification = worker.verifySources(List.of(
                    new KnowledgeIndexingWorkerService.SourceVerificationRequest(
                        source.sourceType(), source.sourceId(), source.meetingId(), source.sourceRevision())))
                    .getFirst();
                int inserted = insertFinding(claim.runId(),
                    new Finding("ORPHANED_POINTS", "MANUAL_REVIEW"),
                    new WorkRow(source.sourceType(), source.sourceId(), source.meetingId(), source.sourceRevision(),
                        claim.generationId(), null, null), null, (String) verification.get("status"));
                findings += inserted;
            }
            long scanned = run.vectorScannedCount() + page.sources().size();
            if (page.nextCursor() == null) {
                jdbc.update("""
                    UPDATE knowledge_reconciliation_runs SET state='COMPLETED',inventory_complete=TRUE,
                        vector_scanned_count=?,finding_count=?,completed_at=CURRENT_TIMESTAMP,
                        claim_token=NULL,claim_expires_at=NULL,expected_generation_epoch=NULL,
                        expected_seal_id=NULL,expected_phase=NULL,expected_checkpoint_source_type=NULL,
                        expected_checkpoint_source_id=NULL,expected_checkpoint_source_revision=NULL,
                        expected_vector_cursor=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?
                    """, scanned, findings, claim.runId());
            } else {
                jdbc.update("""
                    UPDATE knowledge_reconciliation_runs SET vector_cursor=?,vector_scanned_count=?,
                        finding_count=?,claim_token=NULL,claim_expires_at=NULL,
                        expected_generation_epoch=NULL,expected_seal_id=NULL,expected_phase=NULL,
                        expected_checkpoint_source_type=NULL,expected_checkpoint_source_id=NULL,
                        expected_checkpoint_source_revision=NULL,expected_vector_cursor=NULL,
                        updated_at=CURRENT_TIMESTAMP WHERE id=?
                    """, page.nextCursor(), scanned, findings, claim.runId());
            }
            return runData(claim.runId());
        });
    }

    private Map<String, Object> fail(PageClaim claim, String code) {
        return transaction.execute(status -> {
            Run run = lockRun(claim.runId());
            if (!acceptanceFence(run, claim)) return runData(claim.runId());
            Generation generation = lockGeneration(claim.generationId());
            if (!fenceGeneration(run, generation)) return staleLocked(run, claim);
            failLocked(claim.runId(), code);
            return runData(claim.runId());
        });
    }

    private Map<String, Object> staleLocked(Run run, PageClaim claim) {
        failLocked(claim.runId(), "GENERATION_EPOCH_MISMATCH");
        return runData(claim.runId());
    }

    private boolean acceptanceFence(Run run, PageClaim claim) {
        if (!"RUNNING".equals(run.state()) || run.claimToken() == null
                || !claim.claimToken().equals(run.claimToken())) return false;
        OffsetDateTime now = jdbc.queryForObject("SELECT CURRENT_TIMESTAMP", OffsetDateTime.class);
        if (run.claimExpiresAt() == null || !run.claimExpiresAt().isAfter(now)) {
            clearClaim(claim.runId());
            jdbc.update("""
                UPDATE knowledge_reconciliation_runs SET last_error_code='RECONCILIATION_CLAIM_EXPIRED',
                    last_error_summary='Reconciliation page claim expired before acceptance.',
                    updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='RUNNING'
                """, claim.runId());
            return false;
        }
        if (!Objects.equals(run.phase(), claim.phase())
                || !Objects.equals(run.checkpointSourceType(), claim.expectedCheckpointSourceType())
                || !Objects.equals(run.checkpointSourceId(), claim.expectedCheckpointSourceId())
                || !Objects.equals(run.checkpointSourceRevision(), claim.expectedCheckpointSourceRevision())
                || !Objects.equals(normalizeCursor(run.vectorCursor()), normalizeCursor(claim.expectedVectorCursor()))) {
            clearClaim(claim.runId());
            return false;
        }
        if (!Objects.equals(run.expectedPhase(), claim.phase())
                || !Objects.equals(run.expectedSealId(), claim.expectedSealId())) {
            clearClaim(claim.runId());
            return false;
        }
        return true;
    }

    private boolean fenceGeneration(Run run, Generation generation) {
        return generation.writeEpoch() == run.expectedGenerationEpochOrCertification()
            && (!"CERTIFICATION".equals(run.certificationMode())
                || ("SEALED".equals(generation.barrierState())
                    && Objects.equals(run.certificationSealId(), generation.sealId())
                    && Objects.equals(run.certificationEpoch(), generation.writeEpoch())))
            && (!"CERTIFICATION".equals(run.certificationMode())
                || Objects.equals(run.expectedSealId(), generation.sealId()));
    }

    private Finding findingFor(WorkRow work, long pointCount, String status) {
        Integer expected = work.indexedChunkCount();
        if ("CURRENT".equals(status) && work.state() == null) {
            return new Finding("MISSING_WORK", pointCount == 0 ? "REINDEX" : "MANUAL_REVIEW");
        }
        if ("CURRENT".equals(status) && Set.of("INDEXED", "NO_ELIGIBLE_CONTENT").contains(work.state())) {
            if (expected != null && pointCount == expected.longValue()) return null;
            return new Finding(pointCount == 0 ? "MISSING_POINTS" : "INCOMPLETE_POINTS",
                expected == null || pointCount > expected ? "MANUAL_REVIEW" : "REINDEX");
        }
        if ("CURRENT".equals(status)
                && !Set.of("RETRYABLE_FAILURE", "TERMINAL_FAILURE", "SUPERSEDED").contains(work.state())) {
            if (pointCount == 0) return null;
            return new Finding("INCOMPLETE_POINTS", "MANUAL_REVIEW");
        }
        if ("DELETED".equals(status)) return pointCount == 0 ? null : new Finding("DELETED_SOURCE_POINTS", "DELETE");
        if (!"CURRENT".equals(status)) return pointCount == 0 ? null : new Finding("STALE_POINTS", "INVALIDATE");
        return new Finding("STRANDED_WORK", "RETRY");
    }

    private int insertFinding(UUID runId, Finding finding, WorkRow work, Long pointCount, String sourceStatus) {
        String state = work.state() == null ? "NO_WORK" : work.state();
        String detail = "{\"status\":\"" + sourceStatus + "\",\"state\":\"" + state + "\""
            + (pointCount == null ? "" : ",\"pointCount\":" + pointCount) + "}";
        return jdbc.update("""
            INSERT INTO knowledge_reconciliation_findings(
                id,run_id,finding_type,action,source_type,source_id,meeting_id,source_revision,
                generation_id,point_count,detail)
            VALUES (?,?,?,?,?,?,?,?,?,?,CAST(? AS jsonb)) ON CONFLICT DO NOTHING
            """, UUID.randomUUID(), runId, finding.type(), finding.action(), work.sourceType(), work.sourceId(),
            work.meetingId(), work.sourceRevision(), work.generationId(), pointCount, detail);
    }

    private void validateInventoryPage(KnowledgeVectorAudit.InventoryPage page, String cursor, int batchSize) {
        if (page == null || page.sources() == null || page.sources().size() > batchSize) {
            throw new InvalidAuditResponse();
        }
        String next;
        try {
            next = InventoryCursor.normalize(page.nextCursor());
        } catch (IllegalArgumentException invalid) {
            throw new InvalidAuditResponse();
        }
        if (next != null && (next.equals(normalizeCursor(cursor)) || page.sources().isEmpty())) {
            throw new InvalidAuditResponse();
        }
        for (KnowledgeVectorAudit.SourceKey source : page.sources()) {
            if (source == null || source.sourceType() == null || source.sourceId() == null
                    || source.meetingId() == null || source.sourceRevision() < 0
                    || !Set.of("TRANSCRIPT", "SUMMARY", "DECISION", "ACTION_ITEM")
                        .contains(source.sourceType())) throw new InvalidAuditResponse();
        }
    }

    private boolean completeSourceCounts(Map<KnowledgeVectorAudit.SourceKey, Long> counts,
            List<KnowledgeVectorAudit.SourceKey> sources) {
        return counts != null && counts.size() == sources.size()
            && sources.stream().allMatch(source -> counts.containsKey(source)
                && counts.get(source) != null && counts.get(source) >= 0);
    }

    private void clearClaim(UUID runId) {
        jdbc.update("""
            UPDATE knowledge_reconciliation_runs SET claim_token=NULL,claim_expires_at=NULL,
                expected_generation_epoch=NULL,expected_seal_id=NULL,expected_phase=NULL,
                expected_checkpoint_source_type=NULL,expected_checkpoint_source_id=NULL,
                expected_checkpoint_source_revision=NULL,expected_vector_cursor=NULL,
                updated_at=CURRENT_TIMESTAMP WHERE id=?
            """, runId);
    }

    private void failLocked(UUID runId, String code) {
        jdbc.update("""
            UPDATE knowledge_reconciliation_runs SET state='FAILED',last_error_code=?,
                last_error_summary='Reconciliation could not accept the claimed page.',
                inventory_complete=FALSE,claim_token=NULL,claim_expires_at=NULL,
                expected_generation_epoch=NULL,expected_seal_id=NULL,expected_phase=NULL,
                expected_checkpoint_source_type=NULL,expected_checkpoint_source_id=NULL,
                expected_checkpoint_source_revision=NULL,expected_vector_cursor=NULL,
                updated_at=CURRENT_TIMESTAMP WHERE id=?
            """, code, runId);
    }

    private Run lockRun(UUID runId) {
        return jdbc.query("""
            SELECT id,generation_id,batch_size,dry_run,state,checkpoint_source_type,checkpoint_source_id,
                   checkpoint_source_revision,scanned_count,repaired_count,finding_count,phase,vector_cursor,
                   vector_scanned_count,inventory_complete,certification_mode,certification_seal_id,
                   certification_epoch,last_error_code,claim_token,claim_expires_at,expected_generation_epoch,
                   expected_seal_id,expected_phase,expected_checkpoint_source_type,
                   expected_checkpoint_source_id,expected_checkpoint_source_revision,expected_vector_cursor
              FROM knowledge_reconciliation_runs WHERE id=? FOR UPDATE
            """, this::run, runId).stream().findFirst()
            .orElseThrow(() -> new ResponseStatusException(org.springframework.http.HttpStatus.NOT_FOUND));
    }

    private Generation lockGeneration(String generationId) {
        return jdbc.query("""
            SELECT generation_id,configuration_version,configuration_sha256,tokenizer_id,collection_name,
                   state,target_count,indexed_count,write_epoch,write_barrier_state,seal_id,sealed_epoch
              FROM knowledge_index_generations WHERE generation_id=? FOR UPDATE
            """, this::generation, generationId).stream().findFirst()
            .orElseThrow(() -> new ResponseStatusException(org.springframework.http.HttpStatus.NOT_FOUND,
                "Knowledge generation was not found."));
    }

    private List<WorkRow> workRows(Run run) {
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
            return jdbc.query(inventory + " ORDER BY source_type,source_id,source_revision LIMIT ?",
                this::workRow, run.generationId(), run.generationId(), run.batchSize());
        }
        return jdbc.query(inventory + """
             WHERE (source_type,source_id,source_revision) >
                   (CAST(? AS VARCHAR),CAST(? AS UUID),CAST(? AS BIGINT))
             ORDER BY source_type,source_id,source_revision LIMIT ?
            """, this::workRow, run.generationId(), run.generationId(), run.checkpointSourceType(),
            run.checkpointSourceId(), run.checkpointSourceRevision(), run.batchSize());
    }

    private void lockMeetings(List<WorkRow> rows) {
        rows.stream().map(WorkRow::meetingId).filter(Objects::nonNull).distinct().sorted()
            .forEach(meetingId -> jdbc.query("SELECT id FROM meetings WHERE id=? FOR UPDATE",
                (rs, row) -> rs.getObject(1, UUID.class), meetingId));
    }

    private KnowledgeVectorAudit.SourceKey sourceKey(WorkRow row) {
        return new KnowledgeVectorAudit.SourceKey(row.sourceType(), row.sourceId(), row.meetingId(), row.sourceRevision());
    }

    private WorkRow workRow(ResultSet rs, int row) throws SQLException {
        return new WorkRow(rs.getString("source_type"), rs.getObject("source_id", UUID.class),
            rs.getObject("meeting_id", UUID.class), rs.getLong("source_revision"),
            rs.getString("index_generation_id"), rs.getString("state"),
            (Integer) rs.getObject("indexed_chunk_count"));
    }

    private Run run(ResultSet rs, int row) throws SQLException {
        return new Run(rs.getObject("id", UUID.class), rs.getString("generation_id"), rs.getInt("batch_size"),
            rs.getBoolean("dry_run"), rs.getString("state"), rs.getString("checkpoint_source_type"),
            rs.getObject("checkpoint_source_id", UUID.class), (Long) rs.getObject("checkpoint_source_revision"),
            rs.getLong("scanned_count"), rs.getLong("repaired_count"), rs.getLong("finding_count"),
            rs.getString("phase"), rs.getString("vector_cursor"), rs.getLong("vector_scanned_count"),
            rs.getBoolean("inventory_complete"), rs.getString("certification_mode"),
            rs.getObject("certification_seal_id", UUID.class), (Long) rs.getObject("certification_epoch"),
            rs.getString("last_error_code"), rs.getObject("claim_token", UUID.class),
            rs.getObject("claim_expires_at", OffsetDateTime.class),
            (Long) rs.getObject("expected_generation_epoch"), rs.getObject("expected_seal_id", UUID.class),
            rs.getString("expected_phase"), rs.getString("expected_checkpoint_source_type"),
            rs.getObject("expected_checkpoint_source_id", UUID.class),
            (Long) rs.getObject("expected_checkpoint_source_revision"), rs.getString("expected_vector_cursor"));
    }

    private Generation generation(ResultSet rs, int row) throws SQLException {
        return new Generation(rs.getString("generation_id"), rs.getString("configuration_version"),
            rs.getString("configuration_sha256"), rs.getString("tokenizer_id"),
            rs.getString("collection_name"), rs.getString("state"), rs.getLong("target_count"),
            rs.getLong("indexed_count"), rs.getLong("write_epoch"), rs.getString("write_barrier_state"),
            rs.getObject("seal_id", UUID.class), rs.getObject("sealed_epoch", Long.class));
    }

    private Map<String, Object> runData(UUID runId) {
        return jdbc.query("""
            SELECT r.id,r.generation_id,r.batch_size,r.dry_run,r.state,r.checkpoint_source_type,r.checkpoint_source_id,
                   r.checkpoint_source_revision,r.scanned_count,r.repaired_count,r.finding_count,r.last_error_code,
                   r.last_error_summary,r.started_at,r.completed_at,r.updated_at,r.phase,r.vector_cursor,
                   r.vector_scanned_count,r.inventory_complete,r.certification_mode,r.certification_seal_id,
                   r.certification_epoch,r.claim_expires_at,r.claim_attempt,
                   (
                       r.certification_mode='CERTIFICATION'
                       AND r.state='COMPLETED' AND r.dry_run AND r.inventory_complete
                       AND r.finding_count=0 AND r.repaired_count=0
                       AND g.write_barrier_state='SEALED'
                       AND g.seal_id=r.certification_seal_id
                       AND g.sealed_epoch=r.certification_epoch
                       AND g.write_epoch=r.certification_epoch
                   ) AS certification_usable
              FROM knowledge_reconciliation_runs r
              JOIN knowledge_index_generations g ON g.generation_id=r.generation_id
             WHERE r.id=?
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
                data.put("phase", rs.getString("phase"));
                data.put("vectorCursor", rs.getString("vector_cursor"));
                data.put("vectorScannedCount", rs.getLong("vector_scanned_count"));
                data.put("inventoryComplete", rs.getBoolean("inventory_complete"));
                data.put("certificationMode", rs.getString("certification_mode"));
                data.put("certificationSealId", rs.getObject("certification_seal_id", UUID.class));
                data.put("certificationEpoch", rs.getObject("certification_epoch"));
                data.put("certificationUsable", rs.getBoolean("certification_usable"));
                data.put("claimExpiresAt", rs.getObject("claim_expires_at"));
                data.put("claimAttempt", rs.getInt("claim_attempt"));
                data.put("lastErrorCode", rs.getString("last_error_code"));
                data.put("lastErrorSummary", rs.getString("last_error_summary"));
                data.put("startedAt", rs.getObject("started_at"));
                data.put("completedAt", rs.getObject("completed_at"));
                data.put("updatedAt", rs.getObject("updated_at"));
                return data;
            }, runId).stream().findFirst().orElseThrow(() ->
                new ResponseStatusException(org.springframework.http.HttpStatus.NOT_FOUND));
    }

    private static String normalizeCursor(String cursor) {
        try { return InventoryCursor.normalize(cursor); }
        catch (IllegalArgumentException invalid) { return cursor; }
    }

    private static ResponseStatusException conflict(String code) {
        return new ResponseStatusException(org.springframework.http.HttpStatus.CONFLICT, code);
    }

    private record Generation(String id, String configurationVersion, String configurationSha256,
            String tokenizerId, String collectionName, String state, long targetCount, long indexedCount,
            long writeEpoch, String barrierState, UUID sealId, Long sealedEpoch) { }
    private record Run(UUID id, String generationId, int batchSize, boolean dryRun, String state,
            String checkpointSourceType, UUID checkpointSourceId, Long checkpointSourceRevision,
            long scannedCount, long repairedCount, long findingCount, String phase, String vectorCursor,
            long vectorScannedCount, boolean inventoryComplete, String certificationMode,
            UUID certificationSealId, Long certificationEpoch, String lastErrorCode, UUID claimToken,
            OffsetDateTime claimExpiresAt, Long expectedGenerationEpoch, UUID expectedSealId,
            String expectedPhase, String expectedCheckpointSourceType, UUID expectedCheckpointSourceId,
            Long expectedCheckpointSourceRevision, String expectedVectorCursor) {
        long expectedGenerationEpochOrCertification() {
            return expectedGenerationEpoch != null ? expectedGenerationEpoch
                : certificationEpoch == null ? -1 : certificationEpoch;
        }
    }
    private record WorkRow(String sourceType, UUID sourceId, UUID meetingId, long sourceRevision,
            String generationId, String state, Integer indexedChunkCount) { }
    private record Finding(String type, String action) { }
    private record PageClaim(UUID runId, String generationId, int batchSize, boolean dryRun,
            String certificationMode, UUID claimToken, long expectedGenerationEpoch, UUID expectedSealId,
            String phase, String expectedCheckpointSourceType, UUID expectedCheckpointSourceId,
            Long expectedCheckpointSourceRevision, String vectorCursor, List<WorkRow> rows) {
        String expectedVectorCursor() { return vectorCursor; }
    }
    private static final class InvalidAuditResponse extends RuntimeException { }
}
