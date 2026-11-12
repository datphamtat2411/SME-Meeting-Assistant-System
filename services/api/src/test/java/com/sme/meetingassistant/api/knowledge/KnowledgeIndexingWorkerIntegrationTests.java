package com.sme.meetingassistant.api.knowledge;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.time.OffsetDateTime;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.annotation.Transactional;

import static org.mockito.Mockito.when;

@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class KnowledgeIndexingWorkerIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired KnowledgeIndexingWorkerService worker;
    @Autowired KnowledgeIndexingProducer producer;
    @Autowired KnowledgeIndexingAdminService admin;
    @Autowired MediaProperties properties;
    @Autowired MediaRepository outbox;
    @MockitoBean KnowledgeVectorAudit vectorAudit;

    @Test
    @Transactional
    void claimRenewSnapshotAndResultAreFencedToTheLiveSourceAndCertificate() {
        UUID userId = UUID.randomUUID();
        UUID meetingId = UUID.randomUUID();
        UUID itemId = UUID.randomUUID();
        String certificate = "c".repeat(64);
        String configurationSha = "b09c19a082d96d3a3fe66bbdfde4c7f50cde139bd539d456da3f41691ab3f4b1";
        jdbc.update("""
                INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
                VALUES (?,? ,?,'Knowledge worker test user','test-only','EMPLOYEE','ACTIVE')
                """, userId, userId + "@example.invalid", userId + "@example.invalid");
        jdbc.update("""
                INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
                VALUES (?,'Knowledge worker test meeting',?,?)
                """, meetingId, userId, userId);
        jdbc.update("""
                INSERT INTO action_items(id,meeting_id,title,status,assignee_user_id,source_type,created_by_user_id)
                VALUES (? ,?,'Official worker task','OPEN',?,'MANUAL',?)
                """, itemId, meetingId, userId, userId);
        properties.getKnowledgeIndexing().setEnabled(true);
        properties.getKnowledgeIndexing().setConfigurationSha256(configurationSha);
        var event = producer.request("ACTION_ITEM", itemId, meetingId).orElseThrow();
        UUID eventId = event.eventId();
        UUID snapshotId = event.snapshotId();
        byte[] payload = jdbc.queryForObject("SELECT payload FROM knowledge_source_snapshots WHERE id=?",
            byte[].class, snapshotId);
        String snapshotSha = event.snapshotSha256();
        jdbc.update("""
                UPDATE outbox_events SET status='PUBLISHED', published_at=CURRENT_TIMESTAMP WHERE id=?
                """, eventId);
        jdbc.update("""
                UPDATE knowledge_indexing_work SET published_at=CURRENT_TIMESTAMP WHERE event_id=?
                """, eventId);

        var claim = new KnowledgeIndexingWorkerCommands.Claim("1.0", 1, eventId,
            KnowledgeIndexingProducer.EVENT_TYPE, meetingId, "ACTION_ITEM", itemId, event.sourceRevision(),
            snapshotId, snapshotSha, payload.length, "rag-t02-bge-m3-v1", "rag-t02-bge-m3-v1",
            configurationSha,
            "BAAI/bge-m3-tokenizer:5617a9f61b028005a4858fdac845db406aefb181", UUID.randomUUID());
        var claimed = worker.claim(eventId, claim, certificate);
        UUID token = (UUID) claimed.get("claimToken");
        assertThat(token).isNotNull();

        var conflictingClaim = new KnowledgeIndexingWorkerCommands.Claim("1.0", 1, eventId,
            KnowledgeIndexingProducer.EVENT_TYPE, meetingId, "ACTION_ITEM", itemId, 0,
            snapshotId, snapshotSha, payload.length, "rag-t02-bge-m3-v1", "rag-t02-bge-m3-v1",
            configurationSha,
            "BAAI/bge-m3-tokenizer:5617a9f61b028005a4858fdac845db406aefb181", UUID.randomUUID());
        assertThatThrownBy(() -> worker.claim(eventId, conflictingClaim, "d".repeat(64)))
            .isInstanceOf(WorkerException.class)
            .hasMessage("WORKER_ATTEMPT_BUSY");

        var owner = new KnowledgeIndexingWorkerCommands.Owner("1.0", eventId, token);
        var lease = worker.renew(eventId, owner, certificate);
        assertThat(lease).containsKey("leaseExpiresAt");
        var snapshot = worker.snapshot(eventId, owner, certificate);
        assertThat(snapshot.bytes()).containsExactly(payload);
        assertThat(snapshot.sha256()).isEqualTo(snapshotSha);

        var result = new KnowledgeIndexingWorkerCommands.Result("1.0", eventId, token,
            UUID.randomUUID(), "INDEXED", "rag-t02-bge-m3-v1", 1, "d".repeat(64), "NONE");
        var accepted = worker.result(eventId, result, certificate);
        assertThat(accepted).containsEntry("state", "INDEXED").containsEntry("acknowledge", true);

        var replay = worker.result(eventId, result, certificate);
        assertThat(replay).containsEntry("state", "INDEXED").containsEntry("acknowledge", true)
            .containsEntry("replay", true);
        assertThat(jdbc.queryForObject("SELECT attempt_count FROM knowledge_indexing_work WHERE event_id=?",
            Integer.class, eventId)).isEqualTo(1);

        var staleResult = new KnowledgeIndexingWorkerCommands.Result("1.0", eventId, token,
            UUID.randomUUID(), "INDEXED", "rag-t02-bge-m3-v1", 1, "e".repeat(64), "NONE");
        assertThatThrownBy(() -> worker.result(eventId, staleResult, certificate))
            .isInstanceOf(WorkerException.class)
            .hasMessage("WORKER_RESULT_CONFLICT");
    }

    @Test
    @Transactional
    void repeatedRequestsForTheSameRevisionAndGenerationCreateOneWorkRow() {
        UUID userId = UUID.randomUUID();
        UUID meetingId = UUID.randomUUID();
        UUID itemId = UUID.randomUUID();
        insertManualAction(userId, meetingId, itemId);
        enableKnowledgeIndexing();

        var first = producer.request("ACTION_ITEM", itemId, meetingId).orElseThrow();
        assertThat(producer.request("ACTION_ITEM", itemId, meetingId)).isEmpty();

        assertThat(jdbc.queryForObject("SELECT count(*) FROM outbox_events WHERE aggregate_id=?",
            Long.class, itemId)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM knowledge_indexing_work WHERE source_id=?",
            Long.class, itemId)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT snapshot_id FROM knowledge_indexing_work WHERE event_id=?",
            UUID.class, first.eventId())).isEqualTo(first.snapshotId());
    }

    @Test
    @Transactional
    void deletedSourceCanClaimAndCompleteLifecycleWorkWithoutSnapshot() {
        UUID userId = UUID.randomUUID();
        UUID meetingId = UUID.randomUUID();
        UUID itemId = UUID.randomUUID();
        insertManualAction(userId, meetingId, itemId);
        enableKnowledgeIndexing();
        var upsert = producer.request("ACTION_ITEM", itemId, meetingId).orElseThrow();

        var invalidation = producer.requestDelete("ACTION_ITEM", itemId, meetingId, userId).orElseThrow();
        assertThat(invalidation.operation()).isEqualTo("DELETE");
        assertThat(invalidation.snapshotId()).isNull();
        assertThat(jdbc.queryForObject("SELECT operation FROM knowledge_indexing_work WHERE event_id=?",
            String.class, invalidation.eventId())).isEqualTo("DELETE");

        publish(invalidation.eventId());
        var claim = new KnowledgeIndexingWorkerCommands.Claim("1.0", 1, invalidation.eventId(),
            KnowledgeIndexingProducer.EVENT_TYPE, meetingId, "ACTION_ITEM", itemId,
            upsert.sourceRevision(), null, null, 0, "rag-t02-bge-m3-v1", "rag-t02-bge-m3-v1",
            properties.getKnowledgeIndexing().getConfigurationSha256(),
            "BAAI/bge-m3-tokenizer:5617a9f61b028005a4858fdac845db406aefb181",
            "DELETE", "SOURCE_DELETED", UUID.randomUUID());
        String certificate = "c".repeat(64);
        UUID token = (UUID) worker.claim(invalidation.eventId(), claim, certificate).get("claimToken");
        var result = new KnowledgeIndexingWorkerCommands.Result("1.0", invalidation.eventId(), token,
            UUID.randomUUID(), "DELETED", "rag-t02-bge-m3-v1", 0, "d".repeat(64), "NONE");

        assertThat(worker.result(invalidation.eventId(), result, certificate))
            .containsEntry("state", "DELETED").containsEntry("acknowledge", true);
    }

    @Test
    @Transactional
    void generationActivationRequiresCompleteWorkAndRetainsRollbackGeneration() {
        UUID userId = UUID.randomUUID();
        UUID meetingId = UUID.randomUUID();
        UUID itemId = UUID.randomUUID();
        insertManualAction(userId, meetingId, itemId);
        enableKnowledgeIndexing();

        var config = properties.getKnowledgeIndexing();
        String oldGeneration = config.getGenerationId();
        String oldVersion = config.getConfigurationVersion();
        String oldSha = config.getConfigurationSha256();
        String oldTokenizer = config.getTokenizerId();
        String oldCollection = config.getCollectionName();
        String newGeneration = "rag-t02-bge-m3-v2";
        String newVersion = "rag-t02-bge-m3-v2";
        String newSha = "c".repeat(64);
        String newTokenizer = "BAAI/bge-m3-tokenizer:v2";
        String newCollection = "sme_meeting_knowledge_bge_m3_v2";
        try {
            assertThat(admin.prepare(newGeneration, newVersion, newSha, newTokenizer, newCollection))
                .containsEntry("state", "PREPARING");
            assertThat(admin.refresh(newGeneration))
                .containsEntry("state", "PREPARING").containsEntry("targetCount", 1L)
                .containsEntry("indexedCount", 0L);

            var event = producer.requestReindex("ACTION_ITEM", itemId, meetingId, newGeneration, userId)
                .orElseThrow();
            byte[] payload = jdbc.queryForObject("SELECT payload FROM knowledge_source_snapshots WHERE id=?",
                byte[].class, event.snapshotId());
            publish(event.eventId());
            var claim = new KnowledgeIndexingWorkerCommands.Claim("1.0", 1, event.eventId(),
                KnowledgeIndexingProducer.EVENT_TYPE, meetingId, "ACTION_ITEM", itemId,
                event.sourceRevision(), event.snapshotId(), event.snapshotSha256(), payload.length,
                newGeneration, newVersion, newSha, newTokenizer, "UPSERT", "REINDEX_REQUESTED", UUID.randomUUID());
            UUID claimToken = (UUID) worker.claim(event.eventId(), claim, "c".repeat(64)).get("claimToken");
            assertThat(admin.refresh(newGeneration)).containsEntry("state", "PREPARING")
                .containsEntry("targetCount", 1L).containsEntry("indexedCount", 0L);

            var result = new KnowledgeIndexingWorkerCommands.Result("1.0", event.eventId(), claimToken,
                UUID.randomUUID(), "INDEXED", newGeneration, 1, "d".repeat(64), "NONE");
            worker.result(event.eventId(), result, "c".repeat(64));
            assertThat(admin.refresh(newGeneration)).containsEntry("state", "READY")
                .containsEntry("targetCount", 1L).containsEntry("indexedCount", 1L);

            config.setGenerationId(newGeneration);
            config.setConfigurationVersion(newVersion);
            config.setConfigurationSha256(newSha);
            config.setTokenizerId(newTokenizer);
            config.setCollectionName(newCollection);
            assertThat(admin.activate(newGeneration)).containsEntry("state", "ACTIVE");

            config.setGenerationId(oldGeneration);
            config.setConfigurationVersion(oldVersion);
            config.setConfigurationSha256(oldSha);
            config.setTokenizerId(oldTokenizer);
            config.setCollectionName(oldCollection);
            assertThat(admin.activate(oldGeneration)).containsEntry("state", "ACTIVE");
            assertThat(jdbc.queryForObject("SELECT state FROM knowledge_index_generations WHERE generation_id=?",
                String.class, newGeneration)).isEqualTo("RETIRED");
        } finally {
            config.setGenerationId(oldGeneration);
            config.setConfigurationVersion(oldVersion);
            config.setConfigurationSha256(oldSha);
            config.setTokenizerId(oldTokenizer);
            config.setCollectionName(oldCollection);
        }
    }

    @Test
    @Transactional
    void reconciliationFindsIndexedWorkWithMissingQdrantPoints() {

        var fixture = publishedAction();
        String certificate = "c".repeat(64);
        UUID claimToken = (UUID) worker.claim(fixture.event().eventId(),
            claimCommand(fixture, UUID.randomUUID()), certificate).get("claimToken");
        worker.result(fixture.event().eventId(),
            indexedResult(fixture.event().eventId(), claimToken, UUID.randomUUID()), certificate);

        var source = new KnowledgeVectorAudit.SourceKey("ACTION_ITEM", fixture.itemId(), fixture.meetingId(),
            fixture.event().sourceRevision());
        when(vectorAudit.countPoints(fixture.event().indexGenerationId(), java.util.List.of(source)))
            .thenReturn(Map.of(source, 0L));

        when(vectorAudit.inventoryPage(fixture.event().indexGenerationId(), null, 10))
            .thenReturn(new KnowledgeVectorAudit.InventoryPage(java.util.List.of(), null));
        Map<String, Object> result = admin.startReconciliation(
            fixture.event().indexGenerationId(), 10, true, fixture.userId());

        assertThat(result).containsEntry("state", "COMPLETED")
            .containsEntry("findingCount", 1L);
        assertThat(jdbc.queryForObject(
            "SELECT finding_type FROM knowledge_reconciliation_findings WHERE run_id=?",
            String.class, result.get("id"))).isEqualTo("MISSING_POINTS");
        assertThat(jdbc.queryForObject(
            "SELECT action FROM knowledge_reconciliation_findings WHERE run_id=?",
            String.class, result.get("id"))).isEqualTo("REINDEX");
    }

    @Test
    @Transactional
    void reconciliationFindsEligibleCanonicalSourceWithoutAnyIndexingWork() {
        UUID actor=UUID.randomUUID(), meeting=UUID.randomUUID(), item=UUID.randomUUID();
        insertManualAction(actor, meeting, item);
        enableKnowledgeIndexing();
        var key = new KnowledgeVectorAudit.SourceKey("ACTION_ITEM", item, meeting, 0);
        when(vectorAudit.countPoints(properties.getKnowledgeIndexing().getGenerationId(),
            java.util.List.of(key))).thenReturn(Map.of(key, 0L));
        when(vectorAudit.inventoryPage(properties.getKnowledgeIndexing().getGenerationId(), null, 100))
            .thenReturn(new KnowledgeVectorAudit.InventoryPage(java.util.List.of(), null));
        var run = admin.startReconciliation(properties.getKnowledgeIndexing().getGenerationId(),
            100, false, actor);
        assertThat(run).containsEntry("state", "COMPLETED");
        assertThat(jdbc.queryForObject("""
            SELECT finding_type FROM knowledge_reconciliation_findings WHERE run_id=?
            """, String.class, run.get("id"))).isEqualTo("MISSING_WORK");
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM knowledge_indexing_work
            WHERE source_type='ACTION_ITEM' AND source_id=? AND operation='UPSERT'
            """, Integer.class, item)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM outbox_events o JOIN knowledge_indexing_work w ON w.event_id=o.id
            WHERE w.source_id=? AND w.operation='UPSERT'
            """, Integer.class, item)).isEqualTo(1);
    }

    @Test
    @Transactional
    void staleWorkReconciliationUsesHistoricalInvalidationNotCurrentUpsert() {
        var fixture=publishedAction();
        var oldRevision=fixture.event().sourceRevision();
        jdbc.update("UPDATE action_items SET version=version+1 WHERE id=?", fixture.itemId());
        var key = new KnowledgeVectorAudit.SourceKey("ACTION_ITEM",
            fixture.itemId(), fixture.meetingId(), oldRevision);
        var newer = new KnowledgeVectorAudit.SourceKey("ACTION_ITEM",
            fixture.itemId(), fixture.meetingId(), oldRevision + 1);
        when(vectorAudit.countPoints(fixture.event().indexGenerationId(),
            java.util.List.of(key, newer))).thenReturn(Map.of(key, 1L, newer, 0L));
        when(vectorAudit.inventoryPage(fixture.event().indexGenerationId(), null, 100))
            .thenReturn(new KnowledgeVectorAudit.InventoryPage(java.util.List.of(), null));
        var run=admin.startReconciliation(fixture.event().indexGenerationId(), 100, false, fixture.userId());
        assertThat(run).containsEntry("state", "COMPLETED");
        assertThat(jdbc.queryForObject("""
            SELECT action FROM knowledge_reconciliation_findings
             WHERE run_id=? AND source_revision=? AND finding_type='STALE_POINTS'
            """,String.class,run.get("id"),oldRevision)).isEqualTo("INVALIDATE");
        assertThat(jdbc.queryForObject("""
            SELECT action FROM knowledge_reconciliation_findings
             WHERE run_id=? AND source_revision=? AND finding_type='MISSING_WORK'
            """,String.class,run.get("id"),oldRevision + 1)).isEqualTo("REINDEX");
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM knowledge_indexing_work WHERE source_id=? AND operation='INVALIDATE'
              AND source_revision=?
            """,Integer.class,fixture.itemId(),oldRevision)).isEqualTo(1);
        // Canonical revision +1 legitimately has no work and is repaired by
        // MISSING_WORK. That is independent of the exact-revision INVALIDATE.
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM knowledge_indexing_work
             WHERE source_id=? AND source_revision=? AND operation='UPSERT'
            """,Integer.class,fixture.itemId(),oldRevision + 1)).isEqualTo(1);
    }

    @Test
    @Transactional
    void reconciliationFailedVectorAuditCanResumeFromCheckpoint() {
        var fixture=publishedAction();
        // A PENDING work row is legitimately still processing and must not
        // report missing vectors. Make the fixture INDEXED before auditing.
        String certificate = "c".repeat(64);
        UUID token=(UUID)worker.claim(fixture.event().eventId(),
            claimCommand(fixture, UUID.randomUUID()), certificate).get("claimToken");
        worker.result(fixture.event().eventId(),
            indexedResult(fixture.event().eventId(), token, UUID.randomUUID()), certificate);
        var key=new KnowledgeVectorAudit.SourceKey("ACTION_ITEM",fixture.itemId(),
            fixture.meetingId(),fixture.event().sourceRevision());
        var failed=admin.startReconciliation(fixture.event().indexGenerationId(),
            10,true,fixture.userId());
        assertThat(failed).containsEntry("state","FAILED");
        when(vectorAudit.countPoints(fixture.event().indexGenerationId(),
            java.util.List.of(key))).thenReturn(Map.of(key,0L));
        when(vectorAudit.inventoryPage(fixture.event().indexGenerationId(), null, 10))
            .thenReturn(new KnowledgeVectorAudit.InventoryPage(java.util.List.of(), null));
        var resumed=admin.resumeReconciliation((UUID)failed.get("id"),fixture.userId());
        assertThat(resumed).containsEntry("state","COMPLETED")
            .containsEntry("findingCount",1L);
    }

    @Test
    @Transactional
    void reconciliationInventoriesUntrackedQdrantPointsWithoutBlindDeletion() {
        enableKnowledgeIndexing();
        String generation=properties.getKnowledgeIndexing().getGenerationId();
        var source = new KnowledgeVectorAudit.SourceKey("ACTION_ITEM",
            UUID.randomUUID(), UUID.randomUUID(), 3);
        when(vectorAudit.inventoryPage(generation, null, 10))
            .thenReturn(new KnowledgeVectorAudit.InventoryPage(java.util.List.of(source), null));
        var run = admin.startReconciliation(generation, 10, false, UUID.randomUUID());
        assertThat(run).containsEntry("state","COMPLETED")
            .containsEntry("phase","VECTORS")
            .containsEntry("vectorScannedCount",1L)
            .containsEntry("findingCount",1L)
            .containsEntry("repairedCount",0L);
        assertThat(jdbc.queryForMap("""
            SELECT finding_type,action FROM knowledge_reconciliation_findings WHERE run_id=?
            """,run.get("id"))).containsEntry("finding_type","ORPHANED_POINTS")
            .containsEntry("action","MANUAL_REVIEW");
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM knowledge_indexing_work
            """,Integer.class)).isZero();
    }

    @Test
    @Transactional
    void pagedVectorInventoryPersistsCursorAndCompletesOnlyAfterLastPage() {
        enableKnowledgeIndexing();
        String generation=properties.getKnowledgeIndexing().getGenerationId();
        var source=new KnowledgeVectorAudit.SourceKey("ACTION_ITEM",
            UUID.randomUUID(),UUID.randomUUID(),0);
        when(vectorAudit.inventoryPage(generation,null,1))
            .thenReturn(new KnowledgeVectorAudit.InventoryPage(java.util.List.of(source),"7"));
        when(vectorAudit.inventoryPage(generation,"7",1))
            .thenReturn(new KnowledgeVectorAudit.InventoryPage(java.util.List.of(),null));
        var first=admin.startReconciliation(generation,1,true,UUID.randomUUID());
        assertThat(first).containsEntry("state","RUNNING")
            .containsEntry("phase","VECTORS")
            .containsEntry("vectorCursor","7");
        var last=admin.resumeReconciliation((UUID)first.get("id"),UUID.randomUUID());
        assertThat(last).containsEntry("state","COMPLETED")
            .containsEntry("vectorScannedCount",1L)
            .containsEntry("findingCount",1L);
    }

    @Test
    @Transactional
    void expiredClaimIsReplacedAndThePreviousTokenCannotSubmitAResult() {
        var fixture = publishedAction();
        String firstCertificate = "c".repeat(64);
        var firstCommand = claimCommand(fixture, UUID.randomUUID());
        UUID firstToken = (UUID) worker.claim(fixture.event().eventId(), firstCommand, firstCertificate)
            .get("claimToken");

        jdbc.update("UPDATE knowledge_indexing_work SET claim_expires_at=CURRENT_TIMESTAMP - INTERVAL '1 second' "
            + "WHERE event_id=?", fixture.event().eventId());

        assertThatThrownBy(() -> worker.renew(fixture.event().eventId(),
            new KnowledgeIndexingWorkerCommands.Owner("1.0", fixture.event().eventId(), firstToken),
            firstCertificate)).isInstanceOf(WorkerException.class).hasMessage("WORKER_LEASE_LOST");

        UUID secondToken = (UUID) worker.claim(fixture.event().eventId(),
            claimCommand(fixture, UUID.randomUUID()), firstCertificate).get("claimToken");
        assertThat(secondToken).isNotEqualTo(firstToken);
        assertThatThrownBy(() -> worker.result(fixture.event().eventId(),
            indexedResult(fixture.event().eventId(), firstToken, UUID.randomUUID()), firstCertificate))
            .isInstanceOf(WorkerException.class).hasMessage("WORKER_LEASE_LOST");

        assertThat(worker.result(fixture.event().eventId(),
            indexedResult(fixture.event().eventId(), secondToken, UUID.randomUUID()), firstCertificate))
            .containsEntry("state", "INDEXED");
    }

    @Test
    @Transactional
    void retryableResultHonorsBackoffThenAllowsAFreshClaim() {
        var fixture = publishedAction();
        String certificate = "c".repeat(64);
        UUID firstToken = (UUID) worker.claim(fixture.event().eventId(),
            claimCommand(fixture, UUID.randomUUID()), certificate).get("claimToken");

        var retry = new KnowledgeIndexingWorkerCommands.Result("1.0", fixture.event().eventId(), firstToken,
            UUID.randomUUID(), "RETRYABLE_FAILURE", "rag-t02-bge-m3-v1", 0, "d".repeat(64),
            "QDRANT_UNAVAILABLE");
        assertThat(worker.result(fixture.event().eventId(), retry, certificate))
            .containsEntry("state", "RETRYABLE_FAILURE").containsEntry("acknowledge", false);
        assertThatThrownBy(() -> worker.claim(fixture.event().eventId(),
            claimCommand(fixture, UUID.randomUUID()), certificate)).isInstanceOf(WorkerException.class)
            .hasMessage("WORKER_RETRY_BACKOFF");

        jdbc.update("UPDATE knowledge_indexing_work SET next_attempt_at=CURRENT_TIMESTAMP - INTERVAL '1 second' "
            + "WHERE event_id=?", fixture.event().eventId());
        UUID secondToken = (UUID) worker.claim(fixture.event().eventId(),
            claimCommand(fixture, UUID.randomUUID()), certificate).get("claimToken");
        assertThat(secondToken).isNotEqualTo(firstToken);
        assertThat(worker.result(fixture.event().eventId(),
            indexedResult(fixture.event().eventId(), secondToken, UUID.randomUUID()), certificate))
            .containsEntry("state", "INDEXED");
    }

    @Test
    @Transactional(noRollbackFor = WorkerException.class)
    void changedCanonicalRevisionSupersedesAnOlderClaimAndAllowsNewWork() {
        var fixture = publishedAction();
        String certificate = "c".repeat(64);
        UUID oldToken = (UUID) worker.claim(fixture.event().eventId(),
            claimCommand(fixture, UUID.randomUUID()), certificate).get("claimToken");

        jdbc.update("UPDATE action_items SET title='Updated official worker task', version=version+1, "
            + "updated_at=CURRENT_TIMESTAMP WHERE id=?", fixture.itemId());

        assertThatThrownBy(() -> worker.result(fixture.event().eventId(),
            indexedResult(fixture.event().eventId(), oldToken, UUID.randomUUID()), certificate))
            .isInstanceOf(WorkerException.class).hasMessage("WORKER_SOURCE_SUPERSEDED");
        assertThat(jdbc.queryForObject("SELECT state FROM knowledge_indexing_work WHERE event_id=?",
            String.class, fixture.event().eventId())).isEqualTo("SUPERSEDED");

        var replacement = producer.request("ACTION_ITEM", fixture.itemId(), fixture.meetingId()).orElseThrow();
        assertThat(replacement.sourceRevision()).isEqualTo(fixture.event().sourceRevision() + 1);
        assertThat(jdbc.queryForObject("SELECT state FROM knowledge_indexing_work WHERE event_id=?",
            String.class, replacement.eventId())).isEqualTo("PENDING");
    }

    @Test
    @Transactional
    void revisedOfficialActionInvalidatesEveryPreviouslyIndexedRevisionWithoutRevokingBusinessState() {
        var fixture = publishedAction();
        // Explicitly publish a second revision, then a third. Both historical
        // revisions need durable source-scoped cleanup, not only rev N-1.
        jdbc.update("UPDATE action_items SET title='Corrected task',version=version+1 WHERE id=?",
            fixture.itemId());
        producer.request("ACTION_ITEM", fixture.itemId(), fixture.meetingId()).orElseThrow();
        jdbc.update("UPDATE action_items SET title='Final task',version=version+1 WHERE id=?",
            fixture.itemId());
        producer.request("ACTION_ITEM", fixture.itemId(), fixture.meetingId()).orElseThrow();
        assertThat(jdbc.queryForList("""
            SELECT source_revision FROM knowledge_indexing_work
             WHERE meeting_id=? AND source_type='ACTION_ITEM' AND source_id=?
               AND operation='INVALIDATE' ORDER BY source_revision
            """, Long.class, fixture.meetingId(), fixture.itemId()))
            .containsExactly(0L, 1L);
        assertThat(jdbc.queryForObject("SELECT status FROM action_items WHERE id=?",
            String.class, fixture.itemId())).isEqualTo("OPEN");
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM outbox_events o
            JOIN knowledge_indexing_work w ON w.event_id=o.id
            WHERE w.source_id=? AND w.operation='INVALIDATE'
              AND o.event_type='KNOWLEDGE_INDEXING_REQUESTED'
            """, Integer.class, fixture.itemId())).isEqualTo(2);

        // Reprocessing the same logical revision must not produce extra cleanup.
        assertThat(producer.request("ACTION_ITEM", fixture.itemId(), fixture.meetingId()))
            .isEmpty();
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM knowledge_indexing_work
             WHERE source_id=? AND operation='INVALIDATE'
            """, Integer.class, fixture.itemId())).isEqualTo(2);
    }

    @Test
    @Transactional
    void knowledgePublisherConfirmationUpdatesOnlyThePublishedWork() {
        UUID userId = UUID.randomUUID();
        UUID meetingId = UUID.randomUUID();
        UUID publishedItemId = UUID.randomUUID();
        UUID unrelatedItemId = UUID.randomUUID();
        insertManualAction(userId, meetingId, publishedItemId);
        insertActionItem(unrelatedItemId, meetingId, userId, "Unrelated worker task");
        enableKnowledgeIndexing();

        UUID publishedEventId = producer.request("ACTION_ITEM", publishedItemId, meetingId).orElseThrow().eventId();
        UUID unrelatedEventId = producer.request("ACTION_ITEM", unrelatedItemId, meetingId).orElseThrow().eventId();
        Map<String, Object> unrelatedBefore = knowledgeWork(unrelatedEventId);
        UUID claimToken = preparePublisherClaim(publishedEventId, 1);

        assertThat(outbox.markPublished(publishedEventId, claimToken)).isTrue();
        assertThat(jdbc.queryForObject("SELECT status FROM outbox_events WHERE id=?", String.class, publishedEventId))
            .isEqualTo("PUBLISHED");

        OffsetDateTime outboxPublishedAt = jdbc.queryForObject(
            "SELECT published_at FROM outbox_events WHERE id=?", OffsetDateTime.class, publishedEventId);
        OffsetDateTime workPublishedAt = jdbc.queryForObject(
            "SELECT published_at FROM knowledge_indexing_work WHERE event_id=?", OffsetDateTime.class,
            publishedEventId);
        assertThat(outboxPublishedAt).isNotNull();
        assertThat(workPublishedAt).isEqualTo(outboxPublishedAt);

        Map<String, Object> unrelatedAfter = knowledgeWork(unrelatedEventId);
        assertThat(unrelatedAfter.get("state")).isEqualTo("PENDING");
        assertThat(unrelatedAfter.get("published_at")).isNull();
        assertThat(unrelatedAfter.get("updated_at")).isEqualTo(unrelatedBefore.get("updated_at"));
    }

    @Test
    @Transactional
    void knowledgePublisherFailuresPersistRetryMetadataAndTerminalWorkState() {
        UUID userId = UUID.randomUUID();
        UUID meetingId = UUID.randomUUID();
        UUID itemId = UUID.randomUUID();
        insertManualAction(userId, meetingId, itemId);
        enableKnowledgeIndexing();
        UUID eventId = producer.request("ACTION_ITEM", itemId, meetingId).orElseThrow().eventId();

        UUID firstClaim = preparePublisherClaim(eventId, 1);
        assertThat(outbox.markPublishFailed(eventId, firstClaim, 1, 3, "broker-nack-1")).isTrue();
        assertThat(jdbc.queryForObject("SELECT status FROM outbox_events WHERE id=?", String.class, eventId))
            .isEqualTo("PENDING");
        assertThat(jdbc.queryForObject("SELECT attempt_count FROM outbox_events WHERE id=?", Integer.class, eventId))
            .isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT last_error FROM outbox_events WHERE id=?", String.class, eventId))
            .isEqualTo("broker-nack-1");
        assertThat(jdbc.queryForObject("SELECT next_attempt_at > CURRENT_TIMESTAMP FROM outbox_events WHERE id=?",
            Boolean.class, eventId)).isTrue();
        assertThat(jdbc.queryForObject("SELECT state FROM knowledge_indexing_work WHERE event_id=?",
            String.class, eventId)).isEqualTo("PENDING");

        UUID secondClaim = preparePublisherClaim(eventId, 2);
        assertThat(outbox.markPublishFailed(eventId, secondClaim, 2, 3, "broker-nack-2")).isTrue();
        assertThat(jdbc.queryForObject("SELECT status FROM outbox_events WHERE id=?", String.class, eventId))
            .isEqualTo("PENDING");
        assertThat(jdbc.queryForObject("SELECT attempt_count FROM outbox_events WHERE id=?", Integer.class, eventId))
            .isEqualTo(2);

        UUID finalClaim = preparePublisherClaim(eventId, 3);
        assertThat(outbox.markPublishFailed(eventId, finalClaim, 3, 3, "broker-nack-final")).isTrue();
        assertThat(jdbc.queryForObject("SELECT status FROM outbox_events WHERE id=?", String.class, eventId))
            .isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("SELECT attempt_count FROM outbox_events WHERE id=?", Integer.class, eventId))
            .isEqualTo(3);
        assertThat(jdbc.queryForObject("SELECT last_error FROM outbox_events WHERE id=?", String.class, eventId))
            .isEqualTo("broker-nack-final");
        assertThat(jdbc.queryForObject("SELECT state FROM knowledge_indexing_work WHERE event_id=?",
            String.class, eventId)).isEqualTo("TERMINAL_FAILURE");
        assertThat(jdbc.queryForObject("SELECT last_error_code FROM knowledge_indexing_work WHERE event_id=?",
            String.class, eventId)).isEqualTo("OUTBOX_CONFIRM_NOT_OBSERVED");
        assertThat(jdbc.queryForObject("SELECT last_error_summary FROM knowledge_indexing_work WHERE event_id=?",
            String.class, eventId)).isEqualTo("Knowledge indexing notification publication was not confirmed.");
        assertThat(jdbc.queryForObject("SELECT published_at FROM knowledge_indexing_work WHERE event_id=?",
            OffsetDateTime.class, eventId)).isNull();
    }

    @Test
    @Transactional
    void expiredFinalPublisherClaimMakesKnowledgeWorkTerminal() {
        UUID userId = UUID.randomUUID();
        UUID meetingId = UUID.randomUUID();
        UUID itemId = UUID.randomUUID();
        insertManualAction(userId, meetingId, itemId);
        properties.getKnowledgeIndexing().setEnabled(true);
        properties.getKnowledgeIndexing().setConfigurationSha256(
            "b09c19a082d96d3a3fe66bbdfde4c7f50cde139bd539d456da3f41691ab3f4b1");
        UUID eventId = producer.request("ACTION_ITEM", itemId, meetingId).orElseThrow().eventId();
        jdbc.update("""
            UPDATE outbox_events SET attempt_count=12, claim_token=gen_random_uuid(),
                claim_expires_at=CURRENT_TIMESTAMP - INTERVAL '1 second'
            WHERE id=?
            """, eventId);

        assertThat(outbox.claimPendingOutbox(1, 60, 12, false)).isEmpty();
        assertThat(jdbc.queryForObject("SELECT status FROM outbox_events WHERE id=?",
            String.class, eventId)).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("SELECT state FROM knowledge_indexing_work WHERE event_id=?",
            String.class, eventId)).isEqualTo("TERMINAL_FAILURE");
    }

    private void insertManualAction(UUID userId, UUID meetingId, UUID itemId) {
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,? ,?,'Knowledge worker test user','test-only','EMPLOYEE','ACTIVE')
            """, userId, userId + "@example.invalid", userId + "@example.invalid");
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Knowledge worker test meeting',?,?)
            """, meetingId, userId, userId);
        insertActionItem(itemId, meetingId, userId, "Official worker task");
    }

    private void insertActionItem(UUID itemId, UUID meetingId, UUID userId, String title) {
        jdbc.update("""
            INSERT INTO action_items(id,meeting_id,title,status,assignee_user_id,source_type,created_by_user_id)
            VALUES (?, ?, ?, 'OPEN', ?, 'MANUAL', ?)
            """, itemId, meetingId, title, userId, userId);
    }

    private void enableKnowledgeIndexing() {
        properties.getKnowledgeIndexing().setEnabled(true);
        properties.getKnowledgeIndexing().setConfigurationSha256(
            "b09c19a082d96d3a3fe66bbdfde4c7f50cde139bd539d456da3f41691ab3f4b1");
    }

    private UUID preparePublisherClaim(UUID eventId, int attemptCount) {
        UUID claimToken = UUID.randomUUID();
        jdbc.update("""
            UPDATE outbox_events SET status='PENDING', attempt_count=?, claim_token=?,
                claim_expires_at=CURRENT_TIMESTAMP + INTERVAL '60 seconds',
                published_at=NULL, next_attempt_at=CURRENT_TIMESTAMP
            WHERE id=?
            """, attemptCount, claimToken, eventId);
        return claimToken;
    }

    private Map<String, Object> knowledgeWork(UUID eventId) {
        return jdbc.queryForMap("""
            SELECT state, published_at, updated_at FROM knowledge_indexing_work WHERE event_id=?
            """, eventId);
    }

    private PublishedAction publishedAction() {
        UUID userId = UUID.randomUUID();
        UUID meetingId = UUID.randomUUID();
        UUID itemId = UUID.randomUUID();
        insertManualAction(userId, meetingId, itemId);
        enableKnowledgeIndexing();
        var event = producer.request("ACTION_ITEM", itemId, meetingId).orElseThrow();
        byte[] payload = jdbc.queryForObject("SELECT payload FROM knowledge_source_snapshots WHERE id=?",
            byte[].class, event.snapshotId());
        publish(event.eventId());
        return new PublishedAction(userId, meetingId, itemId, event, payload);
    }

    private void publish(UUID eventId) {
        jdbc.update("UPDATE outbox_events SET status='PUBLISHED', published_at=CURRENT_TIMESTAMP WHERE id=?",
            eventId);
        jdbc.update("UPDATE knowledge_indexing_work SET published_at=CURRENT_TIMESTAMP WHERE event_id=?",
            eventId);
    }

    private KnowledgeIndexingWorkerCommands.Claim claimCommand(PublishedAction fixture, UUID requestId) {
        var event = fixture.event();
        return new KnowledgeIndexingWorkerCommands.Claim("1.0", 1, event.eventId(),
            KnowledgeIndexingProducer.EVENT_TYPE, fixture.meetingId(), "ACTION_ITEM", fixture.itemId(),
            event.sourceRevision(), event.snapshotId(), event.snapshotSha256(), fixture.payload().length,
            "rag-t02-bge-m3-v1", "rag-t02-bge-m3-v1",
            properties.getKnowledgeIndexing().getConfigurationSha256(),
            "BAAI/bge-m3-tokenizer:5617a9f61b028005a4858fdac845db406aefb181", requestId);
    }

    private KnowledgeIndexingWorkerCommands.Result indexedResult(UUID eventId, UUID claimToken, UUID resultId) {
        return new KnowledgeIndexingWorkerCommands.Result("1.0", eventId, claimToken, resultId,
            "INDEXED", "rag-t02-bge-m3-v1", 1, "d".repeat(64), "NONE");
    }

    private record PublishedAction(UUID userId, UUID meetingId, UUID itemId,
            KnowledgeIndexingEvent event, byte[] payload) {
        private PublishedAction {
            payload = payload.clone();
        }

        @Override
        public byte[] payload() {
            return payload.clone();
        }
    }
}
