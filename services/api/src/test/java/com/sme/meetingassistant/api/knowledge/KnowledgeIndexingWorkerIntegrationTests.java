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
import org.springframework.transaction.annotation.Transactional;

@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class KnowledgeIndexingWorkerIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired KnowledgeIndexingWorkerService worker;
    @Autowired KnowledgeIndexingProducer producer;
    @Autowired MediaProperties properties;
    @Autowired MediaRepository outbox;

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
        jdbc.update("UPDATE outbox_events SET status='PUBLISHED', published_at=CURRENT_TIMESTAMP WHERE id=?",
            event.eventId());
        jdbc.update("UPDATE knowledge_indexing_work SET published_at=CURRENT_TIMESTAMP WHERE event_id=?",
            event.eventId());
        return new PublishedAction(userId, meetingId, itemId, event, payload);
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
