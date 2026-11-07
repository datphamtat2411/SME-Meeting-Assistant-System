package com.sme.meetingassistant.api.actionitems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.annotation.Transactional;

/**
 * AI-02 database-boundary acceptance, against real PostgreSQL + Flyway V1..V29.
 *
 * These fixtures write raw SQL intentionally: constraints must defend against
 * non-HTTP writers and cannot trust ActionItemService validation alone.
 * SET CONSTRAINTS ALL IMMEDIATE forces deferred receipt-count checks while the
 * test transaction is still open (normal production writes check at COMMIT).
 */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
@Transactional
class ActionItemPersistenceIntegrationTests {
    @Autowired JdbcTemplate jdbc;

    private UUID actor;
    private UUID meeting;
    private UUID media;
    private UUID job;
    private UUID transcript;
    private UUID segment;
    private UUID snapshot;
    private UUID stage;

    @BeforeEach
    void setup() {
        actor = UUID.randomUUID();
        meeting = UUID.randomUUID();
        media = UUID.randomUUID();
        job = UUID.randomUUID();
        transcript = UUID.randomUUID();
        segment = UUID.randomUUID();
        snapshot = UUID.randomUUID();
        stage = UUID.randomUUID();

        String email = "ai02-" + actor + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'AI-02 user','test-only','EMPLOYEE','ACTIVE')
            """, actor, email, email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Action Items persistence',?,?)
            """, meeting, actor, actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,10000,?,CURRENT_TIMESTAMP)
            """, media, meeting, "meetings/" + meeting + "/sources/" + media,
            "meetings/" + meeting + "/pending/" + media, actor);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status)
            VALUES (?,?,?,?,'RUNNING')
            """, job, meeting, media, actor);
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,version_number,
                language_code,status,is_current,content_revision)
            VALUES (?,?,?,?,1,'vi','READY',TRUE,3)
            """, transcript, meeting, media, job);
        jdbc.update("""
            INSERT INTO transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,current_text,quality_status)
            VALUES (?,?,0,0,1000,'Prepare the report','ACCEPTED')
            """, segment, transcript);
        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(
                id,meeting_id,source_media_id,processing_job_id,transcript_id,
                content_revision,sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,3,?,?,100)
            """, snapshot, meeting, media, job, transcript, "a".repeat(64),
            "processing/" + job + "/intelligence/source/" + snapshot + ".json");
        insertStage(stage, "EXTRACTING_ACTION_ITEMS", 1);
    }

    @Test
    void zeroCandidateBatchHasDurableReceiptWithoutFakeTasks() {
        UUID receipt = UUID.randomUUID();
        insertReceipt(receipt, stage, snapshot, transcript, 3, 0);
        validateDeferredConstraints();

        assertThat(jdbc.queryForObject(
            "SELECT candidate_count FROM action_item_batch_receipts WHERE id=?",
            Integer.class, receipt)).isZero();
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM action_items WHERE proposal_batch_id=?",
            Integer.class, receipt)).isZero();
    }

    @Test
    void validBatchHasExactlyItsCandidatesAndSameTranscriptEvidence() {
        UUID receipt = UUID.randomUUID(), item = UUID.randomUUID();
        insertReceipt(receipt, stage, snapshot, transcript, 3, 1);
        insertCandidate(item, receipt, "candidate-1", transcript, 3);
        jdbc.update("""
            INSERT INTO action_item_evidence(action_item_id,transcript_id,transcript_segment_id)
            VALUES (?,?,?)
            """, item, transcript, segment);
        validateDeferredConstraints();

        assertThat(jdbc.queryForObject(
            "SELECT status FROM action_items WHERE id=?", String.class, item)).isEqualTo("PROPOSED");
        assertThat(jdbc.queryForObject(
            "SELECT assignee_user_id FROM action_items WHERE id=?", UUID.class, item)).isNull();
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM action_item_evidence WHERE action_item_id=?",
            Integer.class, item)).isEqualTo(1);
    }

    @Test
    void forgedAcceptedCandidateCountFailsAtTransactionBoundary() {
        UUID receipt = UUID.randomUUID();
        insertReceipt(receipt, stage, snapshot, transcript, 3, 2);
        insertCandidate(UUID.randomUUID(), receipt, "candidate-1", transcript, 3);

        assertThatThrownBy(this::validateDeferredConstraints)
            .isInstanceOf(DataIntegrityViolationException.class)
            .hasMessageContaining("receipt count");
    }

    @Test
    void receiptMustBelongToActionExtractionStage() {
        UUID wrongStage = UUID.randomUUID();
        insertStage(wrongStage, "EXTRACTING_DECISIONS", 1);
        assertThatThrownBy(() ->
            insertReceipt(UUID.randomUUID(), wrongStage, snapshot, transcript, 3, 0))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void receiptMustReferenceExactPinnedSnapshotAndRevision() {
        assertThatThrownBy(() ->
            insertReceipt(UUID.randomUUID(), stage, snapshot, transcript, 4, 0))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void proposalCannotBypassCanonicalReceipt() {
        UUID unacceptedReceiptId = UUID.randomUUID();
        assertThatThrownBy(() ->
            insertCandidate(UUID.randomUUID(), unacceptedReceiptId, "orphan", transcript, 3))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void sameCandidateKeyIsUniqueWithinBatch() {
        UUID receipt = UUID.randomUUID();
        insertReceipt(receipt, stage, snapshot, transcript, 3, 2);
        insertCandidate(UUID.randomUUID(), receipt, "candidate-1", transcript, 3);

        assertThatThrownBy(() ->
            insertCandidate(UUID.randomUUID(), receipt, "candidate-1", transcript, 3))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void candidateKeyCanBeReusedAcrossDifferentStageAttempts() {
        UUID secondStage = UUID.randomUUID();
        insertStage(secondStage, "EXTRACTING_ACTION_ITEMS", 2);
        UUID first = UUID.randomUUID(), second = UUID.randomUUID();
        insertReceipt(first, stage, snapshot, transcript, 3, 1);
        insertReceipt(second, secondStage, snapshot, transcript, 3, 1);
        insertCandidate(UUID.randomUUID(), first, "same-key", transcript, 3);
        insertCandidate(UUID.randomUUID(), second, "same-key", transcript, 3);
        validateDeferredConstraints();

        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM action_items WHERE source_item_key='same-key' AND meeting_id=?",
            Integer.class, meeting)).isEqualTo(2);
    }

    @Test
    void newAiProposalCannotBeginOfficialOrAssigned() {
        UUID receipt = UUID.randomUUID();
        insertReceipt(receipt, stage, snapshot, transcript, 3, 1);
        UUID item = UUID.randomUUID();

        assertThatThrownBy(() -> jdbc.update("""
            INSERT INTO action_items(id,meeting_id,title,status,source_type,assignee_user_id,
                processing_job_id,proposal_batch_id,source_item_key,transcript_id,content_revision)
            VALUES (?,?,'Unreviewed task','PROPOSED','AI_EXTRACTED',?,?,?,?,?,?)
            """, item, meeting, actor, job, receipt, "candidate-1", transcript, 3L))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void evidenceCannotPointToSegmentOfAnotherTranscript() {
        UUID receipt = UUID.randomUUID(), item = UUID.randomUUID();
        insertReceipt(receipt, stage, snapshot, transcript, 3, 1);
        insertCandidate(item, receipt, "candidate-1", transcript, 3);
        // A second legitimate meeting has its own active job. Never create
        // two active jobs inside one meeting merely to fabricate foreign evidence.
        UUID otherMeeting = UUID.randomUUID(), otherMedia = UUID.randomUUID();
        UUID otherJob = UUID.randomUUID(), otherTranscript = UUID.randomUUID();
        UUID foreignSegment = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Another meeting',?,?)
            """, otherMeeting, actor, actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,10000,?,CURRENT_TIMESTAMP)
            """, otherMedia, otherMeeting,
            "meetings/" + otherMeeting + "/sources/" + otherMedia,
            "meetings/" + otherMeeting + "/pending/" + otherMedia, actor);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status)
            VALUES (?,?,?,?,'RUNNING')
            """, otherJob, otherMeeting, otherMedia, actor);
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,version_number,
                language_code,status,is_current,content_revision)
            VALUES (?,?,?,?,1,'vi','READY',TRUE,3)
            """, otherTranscript, otherMeeting, otherMedia, otherJob);
        jdbc.update("""
            INSERT INTO transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,current_text,quality_status)
            VALUES (?,?,0,0,1000,'Foreign evidence','ACCEPTED')
            """, foreignSegment, otherTranscript);

        assertThatThrownBy(() -> jdbc.update("""
            INSERT INTO action_item_evidence(action_item_id,transcript_id,transcript_segment_id)
            VALUES (?,?,?)
            """, item, transcript, foreignSegment))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void acceptedReceiptCannotBeChangedOrDeleted() {
        UUID receipt = UUID.randomUUID();
        insertReceipt(receipt, stage, snapshot, transcript, 3, 0);
        validateDeferredConstraints();
        assertThatThrownBy(() -> jdbc.update(
            "UPDATE action_item_batch_receipts SET batch_sha256=? WHERE id=?",
            "c".repeat(64), receipt))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void sourceIdentityOfAcceptedProposalCannotBeReparented() {
        UUID receipt = UUID.randomUUID(), item = UUID.randomUUID();
        insertReceipt(receipt, stage, snapshot, transcript, 3, 1);
        insertCandidate(item, receipt, "candidate-1", transcript, 3);
        validateDeferredConstraints();

        assertThatThrownBy(() -> jdbc.update("""
            UPDATE action_items SET source_item_key='candidate-forged',version=version+1
             WHERE id=?
            """, item))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void evidenceIsImmutableEvenAfterHumanChangesProposal() {
        UUID receipt = UUID.randomUUID(), item = UUID.randomUUID();
        insertReceipt(receipt, stage, snapshot, transcript, 3, 1);
        insertCandidate(item, receipt, "candidate-1", transcript, 3);
        jdbc.update("""
            INSERT INTO action_item_evidence(action_item_id,transcript_id,transcript_segment_id)
            VALUES (?,?,?)
            """, item, transcript, segment);
        validateDeferredConstraints();

        assertThatThrownBy(() -> jdbc.update(
            "DELETE FROM action_item_evidence WHERE action_item_id=?", item))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void manualItemsStillOpenWithAssigneeAndAppendOnlyHistory() {
        UUID item = UUID.randomUUID(), history = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO action_items(id,meeting_id,title,status,source_type,assignee_user_id,created_by_user_id)
            VALUES (?,?,'Manual follow-up','OPEN','MANUAL',?,?)
            """, item, meeting, actor, actor);
        jdbc.update("""
            INSERT INTO action_item_history(id,action_item_id,change_type,to_value,changed_by_user_id)
            VALUES (?,?,'STATUS','OPEN',?)
            """, history, item, actor);
        jdbc.update("""
            UPDATE action_items SET status='DONE',completed_by_user_id=?,completed_at=CURRENT_TIMESTAMP,
                version=version+1 WHERE id=?
            """, actor, item);
        assertThat(jdbc.queryForObject(
            "SELECT status FROM action_items WHERE id=?", String.class, item)).isEqualTo("DONE");
        assertThatThrownBy(() -> jdbc.update(
            "DELETE FROM action_item_history WHERE id=?", history))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    private void insertStage(UUID id, String code, int attempt) {
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status,
                claim_token,lease_expires_at)
            VALUES (?,?,?,?,'RUNNING',?,CURRENT_TIMESTAMP+INTERVAL '1 hour')
            """, id, job, code, attempt, UUID.randomUUID());
    }

    private void insertReceipt(UUID receiptId, UUID stageId, UUID sourceId,
            UUID transcriptId, long revision, int count) {
        jdbc.update("""
            INSERT INTO action_item_batch_receipts(id,meeting_id,processing_job_id,stage_run_id,
                source_snapshot_id,transcript_id,content_revision,is_stale,batch_sha256,candidate_count)
            VALUES (?,?,?,?,?,?,?,FALSE,?,?)
            """, receiptId, meeting, job, stageId, sourceId, transcriptId,
            revision, "b".repeat(64), count);
    }

    private void insertCandidate(UUID itemId, UUID receiptId, String key,
            UUID transcriptId, long revision) {
        jdbc.update("""
            INSERT INTO action_items(id,meeting_id,title,status,source_type,
                processing_job_id,proposal_batch_id,source_item_key,transcript_id,content_revision)
            VALUES (?,?,'AI candidate','PROPOSED','AI_EXTRACTED',?,?,?,?,?)
            """, itemId, meeting, job, receiptId, key, transcriptId, revision);
    }

    private void validateDeferredConstraints() {
        jdbc.execute("SET CONSTRAINTS ALL IMMEDIATE");
    }
}
