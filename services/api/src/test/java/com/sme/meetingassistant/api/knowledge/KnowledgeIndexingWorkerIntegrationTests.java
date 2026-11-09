package com.sme.meetingassistant.api.knowledge;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
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
        String configurationSha = "b".repeat(64);
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
            snapshotId, snapshotSha, payload.length, "rag-t01-v1", "chunking-v1",
            configurationSha, "bge-m3", UUID.randomUUID());
        var claimed = worker.claim(eventId, claim, certificate);
        UUID token = (UUID) claimed.get("claimToken");
        assertThat(token).isNotNull();

        var conflictingClaim = new KnowledgeIndexingWorkerCommands.Claim("1.0", 1, eventId,
            KnowledgeIndexingProducer.EVENT_TYPE, meetingId, "ACTION_ITEM", itemId, 0,
            snapshotId, snapshotSha, payload.length, "rag-t01-v1", "chunking-v1",
            configurationSha, "bge-m3", UUID.randomUUID());
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
            UUID.randomUUID(), "INDEXED", "rag-t01-v1", 1, "d".repeat(64), "NONE");
        var accepted = worker.result(eventId, result, certificate);
        assertThat(accepted).containsEntry("state", "INDEXED").containsEntry("acknowledge", true);

        var staleResult = new KnowledgeIndexingWorkerCommands.Result("1.0", eventId, token,
            UUID.randomUUID(), "INDEXED", "rag-t01-v1", 1, "e".repeat(64), "NONE");
        assertThatThrownBy(() -> worker.result(eventId, staleResult, certificate))
            .isInstanceOf(WorkerException.class)
            .hasMessage("WORKER_RESULT_CONFLICT");
    }

    @Test
    @Transactional
    void expiredFinalPublisherClaimMakesKnowledgeWorkTerminal() {
        UUID userId = UUID.randomUUID();
        UUID meetingId = UUID.randomUUID();
        UUID itemId = UUID.randomUUID();
        insertManualAction(userId, meetingId, itemId);
        properties.getKnowledgeIndexing().setEnabled(true);
        properties.getKnowledgeIndexing().setConfigurationSha256("b".repeat(64));
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
        jdbc.update("""
            INSERT INTO action_items(id,meeting_id,title,status,assignee_user_id,source_type,created_by_user_id)
            VALUES (? ,?,'Official worker task','OPEN',?,'MANUAL',?)
            """, itemId, meetingId, userId, userId);
    }
}
