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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.transaction.BeforeTransaction;
import org.springframework.test.context.transaction.TestTransaction;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.annotation.Transactional;

import static org.mockito.Mockito.when;

@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class KnowledgeIndexingWorkerIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired KnowledgeIndexingWorkerService worker;
    @Autowired KnowledgeIndexingProducer producer;
    @Autowired KnowledgeIndexingAdminService admin;
    @Autowired MediaProperties properties;
    @Autowired MediaRepository outbox;
    @MockitoBean KnowledgeVectorAudit vectorAudit;

    /** These tests use a dedicated Testcontainers database and commit reconciliation fixtures. */
    @BeforeTransaction
    void resetTestDatabase() {
        jdbc.execute("TRUNCATE meetings, outbox_events, knowledge_index_generations CASCADE");
        jdbc.update("""
            INSERT INTO knowledge_index_generations(generation_id,configuration_version,
                configuration_sha256,tokenizer_id,collection_name,state,activated_at)
            VALUES ('rag-t02-bge-m3-v1','rag-t02-bge-m3-v1',
                'b09c19a082d96d3a3fe66bbdfde4c7f50cde139bd539d456da3f41691ab3f4b1',
                'BAAI/bge-m3-tokenizer:5617a9f61b028005a4858fdac845db406aefb181',
                'sme_meeting_knowledge_bge_m3','ACTIVE',CURRENT_TIMESTAMP)
            """);
    }

    private void commitFixture() {
        TestTransaction.flagForCommit();
        TestTransaction.end();
    }

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
        completePermit(eventId, "UPSERT", token, certificate, "SUCCEEDED", "NONE");
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
    void qdrantPermitIsReservedStartedOnceAndTerminallyConsumed() {
        var fixture = publishedAction();
        String certificate = "c".repeat(64);
        UUID claimToken = (UUID) worker.claim(fixture.event().eventId(),
            claimCommand(fixture, UUID.randomUUID()), certificate).get("claimToken");
        String generationId = fixture.event().indexGenerationId();
        UUID executionId = UUID.randomUUID();
        var acquire = worker.acquirePermit(fixture.event().eventId(),
            new KnowledgeIndexingWorkerCommands.PermitAcquire("1.0", fixture.event().eventId(),
                claimToken, "UPSERT", generationId, executionId), certificate);
        UUID permitId = (UUID) acquire.get("permitId");
        assertThat(acquire).containsEntry("state", "RESERVED");

        var started = worker.startPermit(fixture.event().eventId(),
            new KnowledgeIndexingWorkerCommands.PermitStart("1.0", fixture.event().eventId(), permitId,
                claimToken, generationId, executionId), certificate);
        assertThat(started).containsEntry("state", "RUNNING");
        assertThatThrownBy(() -> worker.startPermit(fixture.event().eventId(),
            new KnowledgeIndexingWorkerCommands.PermitStart("1.0", fixture.event().eventId(), permitId,
                claimToken, generationId, executionId), certificate))
            .isInstanceOf(WorkerException.class)
            .hasMessage("WORKER_PERMIT_ALREADY_STARTED");

        var complete = worker.completePermit(fixture.event().eventId(),
            new KnowledgeIndexingWorkerCommands.PermitComplete("1.0", fixture.event().eventId(), permitId,
                claimToken, generationId, executionId, "SUCCEEDED", "NONE"), certificate);
        assertThat(complete).containsEntry("state", "SUCCEEDED");
        assertThatThrownBy(() -> worker.acquirePermit(fixture.event().eventId(),
            new KnowledgeIndexingWorkerCommands.PermitAcquire("1.0", fixture.event().eventId(),
                claimToken, "UPSERT", generationId, executionId), certificate))
            .isInstanceOf(WorkerException.class)
            .hasMessage("WORKER_PERMIT_NOT_REUSABLE");
    }

    @Test
    @Transactional
    void renewalWhilePermitIsRunningKeepsItsExecutionIdentity() {
        var fixture = publishedAction();
        var event = fixture.event();
        String certificate = "c".repeat(64);
        UUID token = (UUID) worker.claim(event.eventId(), claimCommand(fixture, UUID.randomUUID()), certificate).get("claimToken");
        UUID execution = UUID.randomUUID();
        UUID permit = (UUID) worker.acquirePermit(event.eventId(), new KnowledgeIndexingWorkerCommands.PermitAcquire(
            "1.0", event.eventId(), token, "UPSERT", event.indexGenerationId(), execution), certificate).get("permitId");
        worker.startPermit(event.eventId(), new KnowledgeIndexingWorkerCommands.PermitStart(
            "1.0", event.eventId(), permit, token, event.indexGenerationId(), execution), certificate);
        long epoch = jdbc.queryForObject("SELECT write_epoch FROM knowledge_index_generations WHERE generation_id=?",
            Long.class, event.indexGenerationId());
        worker.renew(event.eventId(), new KnowledgeIndexingWorkerCommands.Owner("1.0", event.eventId(), token), certificate);
        assertThat(jdbc.queryForObject("SELECT state FROM knowledge_qdrant_write_permits WHERE permit_id=?", String.class, permit))
            .isEqualTo("RUNNING");
        assertThat(jdbc.queryForObject("SELECT write_epoch FROM knowledge_index_generations WHERE generation_id=?",
            Long.class, event.indexGenerationId())).isEqualTo(epoch);
        worker.completePermit(event.eventId(), new KnowledgeIndexingWorkerCommands.PermitComplete(
            "1.0", event.eventId(), permit, token, event.indexGenerationId(), execution, "SUCCEEDED", "NONE"), certificate);
        assertThat(worker.result(event.eventId(), indexedResult(event.eventId(), token, UUID.randomUUID()), certificate))
            .containsEntry("state", "INDEXED");
    }

    @Test
    @Transactional
    void differentSourcesCanCompleteRunningPermitsInReverseOrderAcrossTransactions() {
        var first = publishedAction();
        var second = publishedAction();
        String certificate = "c".repeat(64);
        UUID firstToken = (UUID) worker.claim(first.event().eventId(), claimCommand(first, UUID.randomUUID()), certificate).get("claimToken");
        UUID secondToken = (UUID) worker.claim(second.event().eventId(), claimCommand(second, UUID.randomUUID()), certificate).get("claimToken");
        UUID firstExecution = UUID.randomUUID(), secondExecution = UUID.randomUUID();
        String generation = first.event().indexGenerationId();
        UUID firstPermit = (UUID) worker.acquirePermit(first.event().eventId(), new KnowledgeIndexingWorkerCommands.PermitAcquire(
            "1.0", first.event().eventId(), firstToken, "UPSERT", generation, firstExecution), certificate).get("permitId");
        UUID secondPermit = (UUID) worker.acquirePermit(second.event().eventId(), new KnowledgeIndexingWorkerCommands.PermitAcquire(
            "1.0", second.event().eventId(), secondToken, "UPSERT", generation, secondExecution), certificate).get("permitId");
        worker.startPermit(first.event().eventId(), new KnowledgeIndexingWorkerCommands.PermitStart(
            "1.0", first.event().eventId(), firstPermit, firstToken, generation, firstExecution), certificate);
        worker.startPermit(second.event().eventId(), new KnowledgeIndexingWorkerCommands.PermitStart(
            "1.0", second.event().eventId(), secondPermit, secondToken, generation, secondExecution), certificate);
        commitFixture();
        worker.completePermit(second.event().eventId(), new KnowledgeIndexingWorkerCommands.PermitComplete(
            "1.0", second.event().eventId(), secondPermit, secondToken, generation, secondExecution, "SUCCEEDED", "NONE"), certificate);
        assertThat(worker.result(second.event().eventId(), indexedResult(second.event().eventId(), secondToken, UUID.randomUUID()), certificate))
            .containsEntry("state", "INDEXED");
        worker.completePermit(first.event().eventId(), new KnowledgeIndexingWorkerCommands.PermitComplete(
            "1.0", first.event().eventId(), firstPermit, firstToken, generation, firstExecution, "SUCCEEDED", "NONE"), certificate);
        assertThat(worker.result(first.event().eventId(), indexedResult(first.event().eventId(), firstToken, UUID.randomUUID()), certificate))
            .containsEntry("state", "INDEXED");
    }

    @Test
    @Transactional
    void lostStartAcknowledgementCannotSpendThePermitAgain() {
        var fixture = publishedAction();
        var event = fixture.event();
        String certificate = "c".repeat(64);
        UUID token = (UUID) worker.claim(event.eventId(), claimCommand(fixture, UUID.randomUUID()), certificate).get("claimToken");
        UUID execution = UUID.randomUUID();
        UUID permit = (UUID) worker.acquirePermit(event.eventId(), new KnowledgeIndexingWorkerCommands.PermitAcquire(
            "1.0", event.eventId(), token, "UPSERT", event.indexGenerationId(), execution), certificate).get("permitId");
        var command = new KnowledgeIndexingWorkerCommands.PermitStart("1.0", event.eventId(), permit, token,
            event.indexGenerationId(), execution);
        worker.startPermit(event.eventId(), command, certificate);
        commitFixture(); // The server committed, but the caller never observed its response.
        assertThatThrownBy(() -> worker.startPermit(event.eventId(), command, certificate))
            .isInstanceOf(WorkerException.class).hasMessage("WORKER_PERMIT_ALREADY_STARTED");
        assertThat(jdbc.queryForObject("SELECT state FROM knowledge_qdrant_write_permits WHERE permit_id=?", String.class, permit))
            .isEqualTo("RUNNING");
        assertThat(jdbc.queryForObject("SELECT count(*) FROM knowledge_qdrant_write_permits WHERE event_id=?", Integer.class, event.eventId()))
            .isEqualTo(1);
    }

    @Test
    @Transactional
    void sealRefusesRunningExternalWriterEvenAfterWorkerLeaseExpires() {
        var fixture = publishedAction();
        String generation = "seal-writer-" + UUID.randomUUID();
        String hash = "a".repeat(64), tokenizer = "test-tokenizer", version = "seal-writer-v1";
        admin.prepare(generation, version, hash, tokenizer, "seal_writer_" + UUID.randomUUID());
        var event = producer.requestReindex("ACTION_ITEM", fixture.itemId(), fixture.meetingId(), generation, fixture.userId()).orElseThrow();
        publish(event.eventId());
        var command = new KnowledgeIndexingWorkerCommands.Claim("1.0", 1, event.eventId(),
            KnowledgeIndexingProducer.EVENT_TYPE, fixture.meetingId(), "ACTION_ITEM", fixture.itemId(), event.sourceRevision(),
            event.snapshotId(), event.snapshotSha256(), event.snapshotSizeBytes(), generation, version, hash, tokenizer,
            "UPSERT", "REINDEX_REQUESTED", UUID.randomUUID());
        String certificate = "c".repeat(64);
        UUID token = (UUID) worker.claim(event.eventId(), command, certificate).get("claimToken");
        UUID execution = UUID.randomUUID();
        UUID permit = (UUID) worker.acquirePermit(event.eventId(), new KnowledgeIndexingWorkerCommands.PermitAcquire(
            "1.0", event.eventId(), token, "UPSERT", generation, execution), certificate).get("permitId");
        worker.startPermit(event.eventId(), new KnowledgeIndexingWorkerCommands.PermitStart(
            "1.0", event.eventId(), permit, token, generation, execution), certificate);
        // Model stale READY bookkeeping: the independently durable RUNNING permit must still fence sealing.
        jdbc.update("UPDATE knowledge_index_generations SET state='READY',target_count=0,indexed_count=0 WHERE generation_id=?", generation);
        jdbc.update("UPDATE knowledge_indexing_work SET claim_expires_at=CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE event_id=?", event.eventId());
        commitFixture();
        assertThatThrownBy(() -> admin.seal(generation))
            .isInstanceOf(org.springframework.web.server.ResponseStatusException.class).hasMessageContaining("QDRANT_PERMIT_OPEN");
        assertThat(jdbc.queryForObject("SELECT state FROM knowledge_qdrant_write_permits WHERE permit_id=?", String.class, permit)).isEqualTo("RUNNING");
        assertThat(admin.generation(generation)).containsEntry("writeBarrierState", "OPEN");
    }

    @Test
    @Transactional
    void expiredInventoryClaimCannotOverwriteItsSuccessfulReplacement() throws Exception {
        enableKnowledgeIndexing();
        String generation = properties.getKnowledgeIndexing().getGenerationId();
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        var calls = new java.util.concurrent.atomic.AtomicInteger();
        var lateSource = new KnowledgeVectorAudit.SourceKey("ACTION_ITEM", UUID.randomUUID(), UUID.randomUUID(), 0);
        when(vectorAudit.inventoryPage(generation, null, 10)).thenAnswer(invocation -> {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            if (calls.incrementAndGet() == 1) {
                entered.countDown();
                if (!release.await(20, TimeUnit.SECONDS)) throw new IllegalStateException("Inventory gate timed out");
                return new KnowledgeVectorAudit.InventoryPage(java.util.List.of(lateSource), null);
            }
            return new KnowledgeVectorAudit.InventoryPage(java.util.List.of(), null);
        });
        commitFixture();
        try (var executor = Executors.newSingleThreadExecutor()) {
            var first = executor.submit(() -> admin.startReconciliation(generation, 10, true, UUID.randomUUID()));
            try {
                assertThat(entered.await(20, TimeUnit.SECONDS)).isTrue();
                UUID runId = jdbc.queryForObject("SELECT id FROM knowledge_reconciliation_runs WHERE generation_id=?", UUID.class, generation);
                jdbc.update("UPDATE knowledge_reconciliation_runs SET claim_expires_at=CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id=?", runId);
                assertThat(admin.resumeReconciliation(runId, UUID.randomUUID())).containsEntry("state", "COMPLETED")
                    .containsEntry("vectorScannedCount", 0L);
                release.countDown();
                assertThat(first.get(20, TimeUnit.SECONDS)).containsEntry("state", "COMPLETED");
                assertThat(jdbc.queryForObject("SELECT count(*) FROM knowledge_reconciliation_findings WHERE run_id=?", Integer.class, runId)).isZero();
                assertThat(jdbc.queryForObject("SELECT claim_attempt FROM knowledge_reconciliation_runs WHERE id=?", Integer.class, runId)).isEqualTo(3);
            } finally { release.countDown(); }
        }
    }

    @Test
    @Transactional
    void canonicalMutationDuringInventoryRejectsTheRemotePage() throws Exception {
        enableKnowledgeIndexing();
        String generation = "inventory-race-" + UUID.randomUUID();
        admin.prepare(generation, "inventory-race-v1", "a".repeat(64), "test-tokenizer", "inventory_" + UUID.randomUUID());
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        when(vectorAudit.inventoryPage(generation, null, 10)).thenAnswer(invocation -> {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            entered.countDown();
            if (!release.await(20, TimeUnit.SECONDS)) throw new IllegalStateException("Inventory gate timed out");
            return new KnowledgeVectorAudit.InventoryPage(java.util.List.of(), null);
        });
        commitFixture();
        try (var executor = Executors.newSingleThreadExecutor()) {
            var result = executor.submit(() -> admin.startReconciliation(generation, 10, true, UUID.randomUUID()));
            try {
                assertThat(entered.await(20, TimeUnit.SECONDS)).isTrue();
                long before = jdbc.queryForObject("SELECT write_epoch FROM knowledge_index_generations WHERE generation_id=?", Long.class, generation);
                insertManualAction(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID());
                assertThat(jdbc.queryForObject("SELECT write_epoch FROM knowledge_index_generations WHERE generation_id=?", Long.class, generation)).isGreaterThan(before);
                release.countDown();
                assertThat(result.get(20, TimeUnit.SECONDS)).containsEntry("state", "FAILED")
                    .containsEntry("lastErrorCode", "GENERATION_EPOCH_MISMATCH")
                    .containsEntry("inventoryComplete", false);
            } finally { release.countDown(); }
        }
    }

    @Test
    @Transactional
    void unsealDuringCertificationInventoryRejectsTheOldPage() throws Exception {
        enableKnowledgeIndexing();
        String generation = "cert-race-" + UUID.randomUUID();
        admin.prepare(generation, "cert-race-v1", "a".repeat(64), "test-tokenizer", "cert_" + UUID.randomUUID());
        assertThat(admin.refresh(generation)).containsEntry("state", "READY");
        admin.seal(generation);
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        when(vectorAudit.inventoryPage(generation, null, 10)).thenAnswer(invocation -> {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            entered.countDown();
            if (!release.await(20, TimeUnit.SECONDS)) throw new IllegalStateException("Inventory gate timed out");
            return new KnowledgeVectorAudit.InventoryPage(java.util.List.of(), null);
        });
        commitFixture();
        try (var executor = Executors.newSingleThreadExecutor()) {
            var result = executor.submit(() -> admin.startCertification(generation, 10, UUID.randomUUID()));
            try {
                assertThat(entered.await(20, TimeUnit.SECONDS)).isTrue();
                assertThat(admin.unseal(generation)).containsEntry("writeBarrierState", "OPEN");
                release.countDown();
                assertThat(result.get(20, TimeUnit.SECONDS)).containsEntry("state", "FAILED")
                    .containsEntry("lastErrorCode", "GENERATION_EPOCH_MISMATCH")
                    .containsEntry("inventoryComplete", false);
                assertThat(admin.generation(generation)).containsEntry("certificationUsable", false);
            } finally { release.countDown(); }
        }
    }

    @Test
    @Transactional
    void permitCannotStartAfterTheGenerationEpochChanges() {
        var fixture = publishedAction();
        String certificate = "c".repeat(64);
        UUID claimToken = (UUID) worker.claim(fixture.event().eventId(),
            claimCommand(fixture, UUID.randomUUID()), certificate).get("claimToken");
        String generationId = fixture.event().indexGenerationId();
        UUID executionId = UUID.randomUUID();
        var acquire = worker.acquirePermit(fixture.event().eventId(),
            new KnowledgeIndexingWorkerCommands.PermitAcquire("1.0", fixture.event().eventId(),
                claimToken, "UPSERT", generationId, executionId), certificate);
        UUID permitId = (UUID) acquire.get("permitId");

        jdbc.update("UPDATE action_items SET title='Epoch changed',version=version+1 WHERE id=?",
            fixture.itemId());

        assertThatThrownBy(() -> worker.startPermit(fixture.event().eventId(),
            new KnowledgeIndexingWorkerCommands.PermitStart("1.0", fixture.event().eventId(), permitId,
                claimToken, generationId, executionId), certificate))
            .isInstanceOf(WorkerException.class)
            .hasMessage("WORKER_PERMIT_STALE");
        assertThat(jdbc.queryForObject("SELECT state FROM knowledge_qdrant_write_permits WHERE permit_id=?",
            String.class, permitId)).isEqualTo("CANCELLED");
    }

    @Test
    @Transactional
    void staleSourceCannotAcquireAnUpsertPermitAndPersistsSupersession() {
        var fixture = publishedAction();
        String certificate = "c".repeat(64);
        UUID claimToken = (UUID) worker.claim(fixture.event().eventId(),
            claimCommand(fixture, UUID.randomUUID()), certificate).get("claimToken");

        jdbc.update("UPDATE action_items SET title='Superseded before permit',version=version+1 WHERE id=?",
            fixture.itemId());

        assertThatThrownBy(() -> worker.acquirePermit(fixture.event().eventId(),
            new KnowledgeIndexingWorkerCommands.PermitAcquire("1.0", fixture.event().eventId(),
                claimToken, "UPSERT", fixture.event().indexGenerationId(), UUID.randomUUID()), certificate))
            .isInstanceOf(WorkerException.class)
            .hasMessage("WORKER_SOURCE_SUPERSEDED");
        assertThat(jdbc.queryForObject("SELECT state FROM knowledge_indexing_work WHERE event_id=?",
            String.class, fixture.event().eventId())).isEqualTo("SUPERSEDED");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM knowledge_qdrant_write_permits WHERE event_id=?",
            Integer.class, fixture.event().eventId())).isZero();
    }

    @Test
    @Transactional
    void staleSourceClaimPersistsSupersededStateBeforeTheWorkerRetries() {
        var fixture = publishedAction();
        jdbc.update("UPDATE action_items SET title='Superseded before claim',version=version+1 WHERE id=?",
            fixture.itemId());

        assertThatThrownBy(() -> worker.claim(fixture.event().eventId(),
            claimCommand(fixture, UUID.randomUUID()), "c".repeat(64)))
            .isInstanceOf(WorkerException.class)
            .hasMessage("WORKER_SOURCE_SUPERSEDED");
        assertThat(jdbc.queryForObject("SELECT state FROM knowledge_indexing_work WHERE event_id=?",
            String.class, fixture.event().eventId())).isEqualTo("SUPERSEDED");
    }

    @Test
    @Transactional
    void summarySelectionEpochCreatesAFreshImmutableIndexSnapshot() {
        UUID actor = UUID.randomUUID();
        UUID meeting = UUID.randomUUID();
        UUID media = UUID.randomUUID();
        UUID job = UUID.randomUUID();
        UUID transcript = UUID.randomUUID();
        UUID stage = UUID.randomUUID();
        UUID sourceSnapshot = UUID.randomUUID();
        UUID receipt = UUID.randomUUID();
        UUID summary = UUID.randomUUID();
        String email = actor + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Summary selection test user','test-only','EMPLOYEE','ACTIVE')
            """, actor, email, email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Summary selection test meeting',?,?)
            """, meeting, actor, actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,
                pending_object_key,content_type,expected_size_bytes,size_bytes,
                duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,10000,?,CURRENT_TIMESTAMP)
            """, media, meeting, "meetings/" + meeting + "/sources/" + media,
            "meetings/" + meeting + "/pending/" + media, actor);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status)
            VALUES (?,?,?,?,'COMPLETED')
            """, job, meeting, media, actor);
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,
                version_number,language_code,status,is_current,content_revision,finalized_at)
            VALUES (?,?,?,?,1,'vi','READY',TRUE,0,CURRENT_TIMESTAMP)
            """, transcript, meeting, media, job);
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'GENERATING_SUMMARY',1,'SUCCEEDED')
            """, stage, job);
        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(id,meeting_id,source_media_id,
                processing_job_id,transcript_id,content_revision,sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,0,?,?,100)
            """, sourceSnapshot, meeting, media, job, transcript, "a".repeat(64),
            "processing/" + job + "/intelligence/source/" + sourceSnapshot + ".json");
        jdbc.update("""
            INSERT INTO meeting_intelligence_result_receipts(id,meeting_id,processing_job_id,
                stage_run_id,result_type,source_snapshot_id,transcript_id,content_revision,
                artifact_sha256,artifact_object_key,artifact_size_bytes)
            VALUES (?,?,?,?,'SUMMARY',?,?,0,?,?,200)
            """, receipt, meeting, job, stage, sourceSnapshot, transcript, "b".repeat(64),
            "processing/" + job + "/intelligence/results/" + stage + ".json");
        jdbc.update("""
            INSERT INTO meeting_summary_versions(id,meeting_id,version_number,content,
                source_type,processing_job_id,result_receipt_id,transcript_id,
                content_revision,quality_status,is_current)
            VALUES (?,?,1,'Selection epoch summary','AI_GENERATED',?,?,?,0,'READY',TRUE)
            """, summary, meeting, job, receipt, transcript);

        enableKnowledgeIndexing();
        var first = producer.request("SUMMARY", summary, meeting).orElseThrow();
        jdbc.update("UPDATE meeting_summary_versions SET is_current=FALSE WHERE id=?", summary);
        jdbc.update("UPDATE meeting_summary_versions SET is_current=TRUE,selection_epoch=1 WHERE id=?", summary);

        var second = producer.request("SUMMARY", summary, meeting).orElseThrow();
        assertThat(second.sourceRevision()).isEqualTo(first.sourceRevision());
        assertThat(second.snapshotId()).isNotEqualTo(first.snapshotId());
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM knowledge_source_snapshots
             WHERE source_type='SUMMARY' AND source_id=? AND source_revision=?
            """, Integer.class, summary, first.sourceRevision())).isEqualTo(2);
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM knowledge_indexing_work
             WHERE source_type='SUMMARY' AND source_id=? AND source_revision=? AND operation='UPSERT'
            """, Integer.class, summary, first.sourceRevision())).isEqualTo(2);
    }

    @Test
    @Transactional
    void deletingTheFinalTranscriptSegmentFencesAReservedPermit() {
        UUID userId = UUID.randomUUID();
        UUID meetingId = UUID.randomUUID();
        UUID mediaId = UUID.randomUUID();
        UUID jobId = UUID.randomUUID();
        UUID transcriptId = UUID.randomUUID();
        UUID segmentId = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,? ,?,'Knowledge transcript test user','test-only','EMPLOYEE','ACTIVE')
            """, userId, userId + "@example.invalid", userId + "@example.invalid");
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Knowledge transcript test meeting',?,?)
            """, meetingId, userId, userId);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,
                pending_object_key,content_type,expected_size_bytes,size_bytes,
                duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,10000,?,CURRENT_TIMESTAMP)
            """, mediaId, meetingId, "meetings/" + meetingId + "/sources/" + mediaId,
            "meetings/" + meetingId + "/pending/" + mediaId, userId);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status)
            VALUES (?,?,?,?,'COMPLETED')
            """, jobId, meetingId, mediaId, userId);
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,
                version_number,language_code,status,is_current,content_revision,finalized_at)
            VALUES (?,?,?,?,1,'vi','READY',TRUE,0,CURRENT_TIMESTAMP)
            """, transcriptId, meetingId, mediaId, jobId);
        jdbc.update("""
            INSERT INTO transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,
                current_text,quality_status)
            VALUES (?,?,0,0,1000,'Final transcript content','ACCEPTED')
            """, segmentId, transcriptId);

        enableKnowledgeIndexing();
        var event = producer.request("TRANSCRIPT", transcriptId, meetingId).orElseThrow();
        byte[] payload = jdbc.queryForObject("SELECT payload FROM knowledge_source_snapshots WHERE id=?",
            byte[].class, event.snapshotId());
        publish(event.eventId());
        var claim = new KnowledgeIndexingWorkerCommands.Claim("1.0", 1, event.eventId(),
            KnowledgeIndexingProducer.EVENT_TYPE, meetingId, "TRANSCRIPT", transcriptId,
            event.sourceRevision(), event.snapshotId(), event.snapshotSha256(), payload.length,
            event.indexGenerationId(), event.configurationVersion(), event.configurationSha256(),
            event.tokenizerId(), "UPSERT", "NEW_REVISION", UUID.randomUUID());
        String certificate = "c".repeat(64);
        UUID claimToken = (UUID) worker.claim(event.eventId(), claim, certificate).get("claimToken");
        UUID executionId = UUID.randomUUID();
        var acquire = worker.acquirePermit(event.eventId(),
            new KnowledgeIndexingWorkerCommands.PermitAcquire("1.0", event.eventId(), claimToken,
                "UPSERT", event.indexGenerationId(), executionId), certificate);
        UUID permitId = (UUID) acquire.get("permitId");
        long epochBefore = jdbc.queryForObject(
            "SELECT write_epoch FROM knowledge_index_generations WHERE generation_id=?",
            Long.class, event.indexGenerationId());

        jdbc.update("DELETE FROM transcript_segments WHERE id=?", segmentId);

        assertThat(jdbc.queryForObject(
            "SELECT write_epoch FROM knowledge_index_generations WHERE generation_id=?",
            Long.class, event.indexGenerationId())).isEqualTo(epochBefore + 1);
        assertThatThrownBy(() -> worker.startPermit(event.eventId(),
            new KnowledgeIndexingWorkerCommands.PermitStart("1.0", event.eventId(), permitId,
                claimToken, event.indexGenerationId(), executionId), certificate))
            .isInstanceOf(WorkerException.class)
            .hasMessage("WORKER_PERMIT_STALE");
        assertThat(jdbc.queryForMap("""
            SELECT state,outcome_code,completed_at FROM knowledge_qdrant_write_permits
             WHERE permit_id=?
            """, permitId))
            .containsEntry("state", "CANCELLED")
            .containsEntry("outcome_code", "WORKER_PERMIT_STALE");
    }

    @Test
    @Transactional
    void concurrentPermitReservationsUseTheMeetingWorkGenerationLockOrder() throws Exception {
        var fixture = publishedAction();
        String certificate = "c".repeat(64);
        UUID claimToken = (UUID) worker.claim(fixture.event().eventId(),
            claimCommand(fixture, UUID.randomUUID()), certificate).get("claimToken");
        commitFixture();

        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        var executor = Executors.newFixedThreadPool(2);
        try {
            var futures = new java.util.ArrayList<java.util.concurrent.Future<Object>>();
            for (int i = 0; i < 2; i++) {
                futures.add(executor.submit(() -> {
                    ready.countDown();
                    if (!start.await(20, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("Concurrent permit gate timed out");
                    }
                    try {
                        return worker.acquirePermit(fixture.event().eventId(),
                            new KnowledgeIndexingWorkerCommands.PermitAcquire("1.0",
                                fixture.event().eventId(), claimToken, "UPSERT",
                                fixture.event().indexGenerationId(), UUID.randomUUID()), certificate);
                    } catch (WorkerException conflict) {
                        return conflict.getMessage();
                    }
                }));
            }
            assertThat(ready.await(20, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            var results = new java.util.ArrayList<Object>();
            for (var future : futures) results.add(future.get(90, TimeUnit.SECONDS));

            assertThat(results.stream().filter(result -> result instanceof Map<?, ?>)).hasSize(1);
            assertThat(results).contains("WORKER_PERMIT_BUSY");
            assertThat(jdbc.queryForObject("""
                SELECT COUNT(*) FROM knowledge_qdrant_write_permits
                 WHERE event_id=? AND state='RESERVED'
                """, Integer.class, fixture.event().eventId())).isEqualTo(1);
        } finally {
            start.countDown();
            executor.shutdownNow();
            assertThat(executor.awaitTermination(20, TimeUnit.SECONDS)).isTrue();
        }
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
    void preV56SnapshotCanBeReusedAfterUpgrade() {
        UUID user = UUID.randomUUID(), meeting = UUID.randomUUID(), item = UUID.randomUUID();
        insertManualAction(user, meeting, item);
        enableKnowledgeIndexing();
        Object candidate = org.springframework.test.util.ReflectionTestUtils.invokeMethod(producer, "actionItem", item, meeting);
        byte[] current = org.springframework.test.util.ReflectionTestUtils.invokeMethod(candidate, "snapshotBytes");
        String v1 = UUID.nameUUIDFromBytes(("sme-knowledge-snapshot-v1:ACTION_ITEM:" + item + ":0")
            .getBytes(java.nio.charset.StandardCharsets.UTF_8)).toString();
        String v2 = UUID.nameUUIDFromBytes(("sme-knowledge-snapshot-v2:ACTION_ITEM:" + item + ":0:0")
            .getBytes(java.nio.charset.StandardCharsets.UTF_8)).toString();
        String currentJson = new String(current, java.nio.charset.StandardCharsets.UTF_8);
        byte[] legacy = currentJson.replace(v2, v1).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        assertThat(new String(legacy, java.nio.charset.StandardCharsets.UTF_8)).contains(v1);
        UUID snapshot = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO knowledge_source_snapshots(id,meeting_id,source_type,source_id,source_revision,payload,sha256,size_bytes)
            VALUES (?,?,'ACTION_ITEM',?,0,?,?,?)
            """, snapshot, meeting, item, legacy, com.sme.meetingassistant.api.media.worker.WorkerJson.sha256(legacy), legacy.length);
        assertThat(producer.request("ACTION_ITEM", item, meeting).orElseThrow().snapshotId()).isEqualTo(snapshot);
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

        completePermit(invalidation.eventId(), "DELETE", token, certificate, "SUCCEEDED", "NONE");
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
            completePermit(event.eventId(), "UPSERT", claimToken, "c".repeat(64), "SUCCEEDED", "NONE");
            worker.result(event.eventId(), result, "c".repeat(64));
            assertThat(admin.refresh(newGeneration)).containsEntry("state", "READY")
                .containsEntry("targetCount", 1L).containsEntry("indexedCount", 1L);
            commitFixture();
            assertThat(admin.seal(newGeneration)).containsEntry("writeBarrierState", "SEALED");

            // READY is not sufficient: require the completed Qdrant inventory
            // evidence before a new generation becomes active.
            var audited = new KnowledgeVectorAudit.SourceKey("ACTION_ITEM", itemId, meetingId,
                event.sourceRevision());
            when(vectorAudit.countPoints(newGeneration, java.util.List.of(audited)))
                .thenAnswer(invocation -> {
                    assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
                    return Map.of(audited, 1L);
                });
            when(vectorAudit.inventoryPage(newGeneration, null, 10))
                .thenReturn(new KnowledgeVectorAudit.InventoryPage(java.util.List.of(audited), "abcd"),
                    new KnowledgeVectorAudit.InventoryPage(java.util.List.of(audited), null));
            var invalidAudit = admin.startCertification(newGeneration, 10, userId);
            assertThat(invalidAudit).containsEntry("state", "FAILED")
                .containsEntry("inventoryComplete", false)
                .containsEntry("lastErrorCode", "VECTOR_AUDIT_INVALID");
            config.setGenerationId(newGeneration);
            config.setConfigurationVersion(newVersion);
            config.setConfigurationSha256(newSha);
            config.setTokenizerId(newTokenizer);
            config.setCollectionName(newCollection);
            assertThatThrownBy(() -> admin.activate(newGeneration))
                .isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
            var audit = admin.startCertification(newGeneration, 10, userId);
            assertThat(audit).containsEntry("inventoryComplete", true)
                .containsEntry("findingCount", 0L).containsEntry("repairedCount", 0L);

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
    void newlyIneligibleIndexedSourceCannotQualifyCandidateForActivation() {
        UUID actor=UUID.randomUUID(),meeting=UUID.randomUUID(),summary=UUID.randomUUID();
        UUID media=UUID.randomUUID(),job=UUID.randomUUID(),transcript=UUID.randomUUID();
        UUID stage=UUID.randomUUID(),snapshot=UUID.randomUUID(),receipt=UUID.randomUUID();
        String email=actor+"@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'PI04 freshness reviewer','test-only','EMPLOYEE','ACTIVE')
            """,actor,email,email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'PI04 generation source',?,?)
            """,meeting,actor,actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,
                pending_object_key,content_type,expected_size_bytes,size_bytes,
                duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,10000,?,CURRENT_TIMESTAMP)
            """,media,meeting,"meetings/"+meeting+"/sources/"+media,
            "meetings/"+meeting+"/pending/"+media,actor);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status)
            VALUES (?,?,?,?,'COMPLETED')
            """,job,meeting,media,actor);
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,
                version_number,language_code,status,is_current,content_revision)
            VALUES (?,?,?,?,1,'vi','READY',TRUE,0)
            """,transcript,meeting,media,job);
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'GENERATING_SUMMARY',1,'SUCCEEDED')
            """,stage,job);
        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(id,meeting_id,source_media_id,
                processing_job_id,transcript_id,content_revision,sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,0,?,?,100)
            """,snapshot,meeting,media,job,transcript,"a".repeat(64),
            "processing/"+job+"/intelligence/source/"+snapshot+".json");
        jdbc.update("""
            INSERT INTO meeting_intelligence_result_receipts(id,meeting_id,processing_job_id,
                stage_run_id,result_type,source_snapshot_id,transcript_id,content_revision,
                artifact_sha256,artifact_object_key,artifact_size_bytes)
            VALUES (?,?,?,?,'SUMMARY',?,?,0,?,?,200)
            """,receipt,meeting,job,stage,snapshot,transcript,"b".repeat(64),
            "processing/"+job+"/intelligence/results/"+stage+".json");
        jdbc.update("""
            INSERT INTO meeting_summary_versions(id,meeting_id,version_number,content,
                source_type,processing_job_id,result_receipt_id,transcript_id,
                content_revision,quality_status,is_current)
            VALUES (?,?,1,'Reviewable old summary','AI_GENERATED',?,?,?,0,'READY',TRUE)
            """,summary,meeting,job,receipt,transcript);
        enableKnowledgeIndexing();
        String generation="pi04-fresh-"+UUID.randomUUID();
        String version="pi04-freshness-v1";
        String hash="d".repeat(64);
        String tokenizer="BAAI/bge-m3-tokenizer:pi04";
        String collection="pi04_freshness_"+UUID.randomUUID();
        admin.prepare(generation,version,hash,tokenizer,collection);
        var event=producer.requestReindex("SUMMARY",summary,meeting,generation,actor).orElseThrow();
        byte[] payload=jdbc.queryForObject("""
            SELECT payload FROM knowledge_source_snapshots WHERE id=?
            """,byte[].class,event.snapshotId());
        publish(event.eventId());
        var command=new KnowledgeIndexingWorkerCommands.Claim("1.0",1,event.eventId(),
            KnowledgeIndexingProducer.EVENT_TYPE,meeting,"SUMMARY",summary,
            event.sourceRevision(),event.snapshotId(),event.snapshotSha256(),payload.length,
            generation,version,hash,tokenizer,"UPSERT","REINDEX_REQUESTED",UUID.randomUUID());
        UUID token=(UUID)worker.claim(event.eventId(),command,"c".repeat(64)).get("claimToken");
        completePermit(event.eventId(), "UPSERT", token, "c".repeat(64), "SUCCEEDED", "NONE");
        worker.result(event.eventId(),new KnowledgeIndexingWorkerCommands.Result(
            "1.0",event.eventId(),token,UUID.randomUUID(),"INDEXED",generation,
            1,"d".repeat(64),"NONE"),"c".repeat(64));
        assertThat(admin.refresh(generation)).containsEntry("state","READY")
            .containsEntry("targetCount",1L).containsEntry("indexedCount",1L);

        // Withdrawing current selection is supported by Summary Management.
        // No newer eligible Summary exists, while the old UPSERT receipt is
        // still INDEXED. It MUST NOT count toward candidate readiness.
        jdbc.update("UPDATE meeting_summary_versions SET is_current=FALSE WHERE id=?",summary);
        assertThat(admin.refresh(generation)).containsEntry("state","PREPARING")
            .containsEntry("targetCount",1L).containsEntry("indexedCount",0L);
        assertThat(jdbc.queryForObject("""
            SELECT state FROM knowledge_indexing_work WHERE event_id=?
            """,String.class,event.eventId())).isEqualTo("INDEXED");
    }

    @Test
    @Transactional
    void reconciliationFindsIndexedWorkWithMissingQdrantPoints() {

        var fixture = publishedAction();
        String certificate = "c".repeat(64);
        UUID claimToken = (UUID) worker.claim(fixture.event().eventId(),
            claimCommand(fixture, UUID.randomUUID()), certificate).get("claimToken");
        completePermit(fixture.event().eventId(), "UPSERT", claimToken, certificate, "SUCCEEDED", "NONE");
        worker.result(fixture.event().eventId(),
            indexedResult(fixture.event().eventId(), claimToken, UUID.randomUUID()), certificate);

        var source = new KnowledgeVectorAudit.SourceKey("ACTION_ITEM", fixture.itemId(), fixture.meetingId(),
            fixture.event().sourceRevision());
        when(vectorAudit.countPoints(fixture.event().indexGenerationId(), java.util.List.of(source)))
            .thenReturn(Map.of(source, 0L));

        when(vectorAudit.inventoryPage(fixture.event().indexGenerationId(), null, 10))
            .thenReturn(new KnowledgeVectorAudit.InventoryPage(java.util.List.of(), null));
        commitFixture();
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
        commitFixture();
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
        commitFixture();
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
        completePermit(fixture.event().eventId(), "UPSERT", token, certificate, "SUCCEEDED", "NONE");
        worker.result(fixture.event().eventId(),
            indexedResult(fixture.event().eventId(), token, UUID.randomUUID()), certificate);
        var key=new KnowledgeVectorAudit.SourceKey("ACTION_ITEM",fixture.itemId(),
            fixture.meetingId(),fixture.event().sourceRevision());
        commitFixture();
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
        commitFixture();
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
        commitFixture();
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
    void invalidInventoryPageLeavesVectorCheckpointUnchanged() {
        enableKnowledgeIndexing();
        String generation = properties.getKnowledgeIndexing().getGenerationId();
        var source = new KnowledgeVectorAudit.SourceKey("ACTION_ITEM", UUID.randomUUID(), UUID.randomUUID(), 0);
        when(vectorAudit.inventoryPage(generation, null, 10))
            .thenReturn(new KnowledgeVectorAudit.InventoryPage(java.util.List.of(source), "abcd"));

        commitFixture();
        var result = admin.startReconciliation(generation, 10, true, UUID.randomUUID());

        assertThat(result).containsEntry("state", "FAILED")
            .containsEntry("lastErrorCode", "VECTOR_AUDIT_INVALID")
            .containsEntry("vectorCursor", null)
            .containsEntry("vectorScannedCount", 0L)
            .containsEntry("inventoryComplete", false)
            .containsEntry("findingCount", 0L);
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM knowledge_reconciliation_findings WHERE run_id=?
            """, Integer.class, result.get("id"))).isZero();
    }

    @Test
    @Transactional
    void invalidLegacyVectorCheckpointFailsClosedWithoutCallingAi() {
        enableKnowledgeIndexing();
        String generation = properties.getKnowledgeIndexing().getGenerationId();
        UUID runId = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO knowledge_reconciliation_runs(id,generation_id,batch_size,phase,state,vector_cursor)
            VALUES (?,? ,10,'VECTORS','RUNNING','abcd')
            """, runId, generation);

        commitFixture();
        var result = admin.resumeReconciliation(runId, UUID.randomUUID());

        assertThat(result).containsEntry("state", "FAILED")
            .containsEntry("lastErrorCode", "VECTOR_CURSOR_INVALID")
            .containsEntry("vectorCursor", "abcd")
            .containsEntry("vectorScannedCount", 0L)
            .containsEntry("inventoryComplete", false);
        org.mockito.Mockito.verifyNoInteractions(vectorAudit);
    }

    @Test
    @Transactional
    void missingWorkWithUnattributedVectorsRequiresManualReviewNotBlindReindex() {
        UUID actor=UUID.randomUUID(), meeting=UUID.randomUUID(), item=UUID.randomUUID();
        insertManualAction(actor,meeting,item);
        enableKnowledgeIndexing();
        String generation=properties.getKnowledgeIndexing().getGenerationId();
        var key=new KnowledgeVectorAudit.SourceKey("ACTION_ITEM",item,meeting,0);
        when(vectorAudit.countPoints(generation,java.util.List.of(key)))
            .thenReturn(Map.of(key,2L));
        when(vectorAudit.inventoryPage(generation,null,10))
            .thenReturn(new KnowledgeVectorAudit.InventoryPage(java.util.List.of(key),null));
        commitFixture();
        var result=admin.startReconciliation(generation,10,false,actor);
        assertThat(result).containsEntry("state","COMPLETED")
            .containsEntry("inventoryComplete",true).containsEntry("repairedCount",0L);
        assertThat(jdbc.queryForMap("""
            SELECT finding_type,action FROM knowledge_reconciliation_findings
             WHERE run_id=? AND finding_type='MISSING_WORK'
            """,result.get("id"))).containsEntry("action","MANUAL_REVIEW");
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM knowledge_indexing_work WHERE source_id=?
            """,Integer.class,item)).isZero();
    }

    @Test
    @Transactional
    void failedOrAcknowledgedLifecycleWithRemainingPointsCanBeRepairedAgain() {
        var fixture=publishedAction();
        var event=fixture.event();
        // A newer authoritative revision makes the indexed old source stale.
        jdbc.update("UPDATE action_items SET title='Changed',version=version+1 WHERE id=?",
            fixture.itemId());
        var key=new KnowledgeVectorAudit.SourceKey("ACTION_ITEM",fixture.itemId(),
            fixture.meetingId(),event.sourceRevision());
        var next=new KnowledgeVectorAudit.SourceKey("ACTION_ITEM",fixture.itemId(),
            fixture.meetingId(),event.sourceRevision()+1);
        when(vectorAudit.countPoints(event.indexGenerationId(),java.util.List.of(key,next)))
            .thenReturn(Map.of(key,2L,next,0L));
        when(vectorAudit.inventoryPage(event.indexGenerationId(),null,10))
            .thenReturn(new KnowledgeVectorAudit.InventoryPage(java.util.List.of(),null));
        commitFixture();
        var first=admin.startReconciliation(event.indexGenerationId(),10,false,fixture.userId());
        assertThat(first).containsEntry("state","COMPLETED");
        UUID firstIntent=jdbc.queryForObject("""
            SELECT event_id FROM knowledge_indexing_work
             WHERE source_id=? AND source_revision=? AND operation='INVALIDATE'
            """,UUID.class,fixture.itemId(),event.sourceRevision());
        // The worker reports an acknowledged cleanup but the points persist.
        // A second run must not regard that immutable receipt as vector truth.
        jdbc.update("""
            UPDATE knowledge_indexing_work SET state='INVALIDATED' WHERE event_id=?
            """,firstIntent);
        var second=admin.startReconciliation(event.indexGenerationId(),10,false,fixture.userId());
        assertThat(second).containsEntry("state","COMPLETED");
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM knowledge_indexing_work
             WHERE source_id=? AND source_revision=? AND operation='INVALIDATE'
            """,Integer.class,fixture.itemId(),event.sourceRevision())).isEqualTo(2);
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM outbox_events o
             JOIN knowledge_indexing_work w ON w.event_id=o.id
             WHERE w.source_id=? AND w.operation='INVALIDATE'
            """,Integer.class,fixture.itemId())).isEqualTo(2);
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

        completePermit(fixture.event().eventId(), "UPSERT", secondToken, firstCertificate, "SUCCEEDED", "NONE");
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
        completePermit(fixture.event().eventId(), "UPSERT", firstToken, certificate, "FAILED",
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
        completePermit(fixture.event().eventId(), "UPSERT", secondToken, certificate, "SUCCEEDED", "NONE");
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
        completePermit(fixture.event().eventId(), "UPSERT", oldToken, certificate, "SUCCEEDED", "NONE");

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

    private void completePermit(UUID eventId, String operation, UUID claimToken, String certificate,
            String state, String outcomeCode) {
        String generationId = jdbc.queryForObject(
            "SELECT index_generation_id FROM knowledge_indexing_work WHERE event_id=?",
            String.class, eventId);
        UUID mutationExecutionId = UUID.randomUUID();
        Map<String, Object> acquired = worker.acquirePermit(eventId,
            new KnowledgeIndexingWorkerCommands.PermitAcquire("1.0", eventId, claimToken, operation,
                generationId, mutationExecutionId),
            certificate);
        UUID permitId = (UUID) acquired.get("permitId");
        worker.startPermit(eventId, new KnowledgeIndexingWorkerCommands.PermitStart("1.0", eventId,
            permitId, claimToken, generationId, mutationExecutionId), certificate);
        worker.completePermit(eventId, new KnowledgeIndexingWorkerCommands.PermitComplete("1.0", eventId,
            permitId, claimToken, generationId, mutationExecutionId, state, outcomeCode), certificate);
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
