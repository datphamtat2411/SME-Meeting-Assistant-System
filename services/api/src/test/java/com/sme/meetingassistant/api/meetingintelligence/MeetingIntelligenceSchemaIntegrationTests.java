package com.sme.meetingassistant.api.meetingintelligence;

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

@ActiveProfiles("test")
@SpringBootTest(properties = {"app.media.outbox.enabled=false",
    "app.media.processing.stage-lease-sweep-ms=3600000"})
@Import(PostgresTestConfiguration.class)
class MeetingIntelligenceSchemaIntegrationTests {
    private static final String SHA = "a".repeat(64);

    @Autowired JdbcTemplate jdbc;
    private UUID actor;
    private Context source;
    private Context foreign;

    private record Context(UUID meeting, UUID media, UUID job, UUID transcript,
                           UUID segment, UUID summaryStage, UUID decisionStage) {}

    @BeforeEach
    void setUp() {
        actor = UUID.randomUUID();
        String email = "mi02-" + actor + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'MI02 tester','test-only','EMPLOYEE','ACTIVE')
            """, actor, email, email);
        source = createContext();
        foreign = createContext();
    }

    private Context createContext() {
        UUID meeting = UUID.randomUUID(), media = UUID.randomUUID(), job = UUID.randomUUID();
        UUID transcript = UUID.randomUUID(), segment = UUID.randomUUID();
        UUID summaryStage = UUID.randomUUID(), decisionStage = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Meeting Intelligence integrity',?,?)
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
            VALUES (?,?,?,?,1,'vi','READY',TRUE,2)
            """, transcript, meeting, media, job);
        jdbc.update("""
            INSERT INTO transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,current_text,quality_status)
            VALUES (?,?,0,0,1000,'Accepted content','ACCEPTED')
            """, segment, transcript);
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'GENERATING_SUMMARY',1,'RUNNING'),
                   (?,?,'EXTRACTING_DECISIONS',1,'PENDING')
            """, summaryStage, job, decisionStage, job);
        return new Context(meeting, media, job, transcript, segment, summaryStage, decisionStage);
    }

    private UUID snapshot(Context c) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(
                id,meeting_id,source_media_id,processing_job_id,transcript_id,content_revision,
                sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,?,?, ?,1024)
            """, id, c.meeting, c.media, c.job, c.transcript, 2, SHA,
            "processing/" + c.job + "/intelligence/source/" + id + ".json");
        return id;
    }

    private UUID receipt(Context c, UUID snapshot, UUID stage, String type) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_intelligence_result_receipts(
                id,meeting_id,processing_job_id,stage_run_id,result_type,source_snapshot_id,
                transcript_id,content_revision,artifact_sha256,artifact_object_key,artifact_size_bytes)
            VALUES (?,?,?,?,?,?,?,?,?,?,256)
            """, id, c.meeting, c.job, stage, type, snapshot, c.transcript, 2, SHA,
            "processing/" + c.job + "/intelligence/results/" + stage + ".json");
        return id;
    }

    private UUID summary(Context c, UUID receipt, int version, boolean current) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_summary_versions(
                id,meeting_id,version_number,content,source_type,processing_job_id,
                result_receipt_id,transcript_id,content_revision,quality_status,is_current)
            VALUES (?,?,?,'AI summary','AI_GENERATED',?,?,?,?,'READY',?)
            """, id, c.meeting, version, c.job, receipt, c.transcript, 2, current);
        return id;
    }

    private UUID aiDecision(Context c, UUID receipt) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_decisions(
                id,meeting_id,content,status,source_type,processing_job_id,result_receipt_id,
                candidate_key,transcript_id,content_revision)
            VALUES (?,?,'Proposed decision','PROPOSED','AI_EXTRACTED',?,?,?,?,?)
            """, id, c.meeting, c.job, receipt, "candidate-1", c.transcript, 2);
        return id;
    }

    private static void rejected(Runnable action) {
        assertThatThrownBy(action::run).isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void snapshotCannotMixMeetingMediaAndProcessingJobAndIsImmutable() {
        UUID id = snapshot(source);
        rejected(() -> jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(
                id,meeting_id,source_media_id,processing_job_id,transcript_id,content_revision,
                sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,?,?, ?,256)
            """, UUID.randomUUID(), source.meeting, source.media, source.job,
            foreign.transcript, 2, SHA, "processing/" + source.job + "/intelligence/source/" + UUID.randomUUID() + ".json"));
        rejected(() -> jdbc.update("""
            UPDATE meeting_intelligence_source_snapshots SET content_revision=3 WHERE id=?
            """, id));
        assertThat(jdbc.queryForObject("""
            SELECT content_revision FROM meeting_intelligence_source_snapshots WHERE id=?
            """, Long.class, id)).isEqualTo(2);
    }

    @Test
    void receiptIsTypedToRealStageAndUniquePerStageAttempt() {
        UUID snapshot = snapshot(source);
        UUID receipt = receipt(source, snapshot, source.summaryStage, "SUMMARY");
        assertThat(receipt).isNotNull();
        rejected(() -> receipt(source, snapshot, source.summaryStage, "SUMMARY"));
        rejected(() -> receipt(source, snapshot, source.decisionStage, "SUMMARY"));
        rejected(() -> jdbc.update("""
            UPDATE meeting_intelligence_result_receipts SET artifact_sha256=? WHERE id=?
            """, "b".repeat(64), receipt));
    }

    @Test
    void summaryEnforcesCurrentUniquenessHumanAttributionAndImmutableContent() {
        UUID snap = snapshot(source);
        UUID accepted = receipt(source, snap, source.summaryStage, "SUMMARY");
        UUID first = summary(source, accepted, 1, true);
        rejected(() -> summary(source, accepted, 2, true));
        jdbc.update("UPDATE meeting_summary_versions SET is_current=FALSE WHERE id=?", first);
        UUID edited = UUID.randomUUID();
        rejected(() -> jdbc.update("""
            INSERT INTO meeting_summary_versions(
                id,meeting_id,version_number,content,source_type,based_on_summary_version_id,
                transcript_id,content_revision,quality_status,is_current)
            VALUES (?,?,2,'Human revision','HUMAN_EDIT',?,?,2,'READY',TRUE)
            """, edited, source.meeting, first, source.transcript));
        jdbc.update("""
            INSERT INTO meeting_summary_versions(
                id,meeting_id,version_number,content,source_type,based_on_summary_version_id,
                created_by_user_id,transcript_id,content_revision,quality_status,is_current)
            VALUES (?,?,2,'Human revision','HUMAN_EDIT',?,?,?,2,'READY',TRUE)
            """, edited, source.meeting, first, actor, source.transcript);
        rejected(() -> jdbc.update("UPDATE meeting_summary_versions SET content='overwrite' WHERE id=?", first));
        assertThat(jdbc.queryForObject("""
            SELECT content FROM meeting_summary_versions WHERE id=?
            """, String.class, first)).isEqualTo("AI summary");
    }

    @Test
    void decisionEvidenceMustShareSourceTranscriptAndHumanConfirmationIsAttributable() {
        UUID snap = snapshot(source);
        UUID decisionStageReceipt = receipt(source, snap, source.decisionStage, "DECISION_EXTRACTION");
        UUID id = aiDecision(source, decisionStageReceipt);
        jdbc.update("""
            INSERT INTO decision_evidence(decision_id,transcript_id,transcript_segment_id)
            VALUES (?,?,?)
            """, id, source.transcript, source.segment);
        rejected(() -> jdbc.update("""
            INSERT INTO decision_evidence(decision_id,transcript_id,transcript_segment_id)
            VALUES (?,?,?)
            """, id, source.transcript, foreign.segment));
        rejected(() -> jdbc.update("""
            UPDATE meeting_decisions SET status='CONFIRMED',version=1 WHERE id=?
            """, id));
        jdbc.update("""
            UPDATE meeting_decisions
            SET status='CONFIRMED',confirmed_by_user_id=?,confirmed_at=CURRENT_TIMESTAMP,version=1
            WHERE id=?
            """, actor, id);
        rejected(() -> jdbc.update("""
            UPDATE meeting_decisions SET status='PROPOSED',confirmed_by_user_id=NULL,
                confirmed_at=NULL,version=2 WHERE id=?
            """, id));
        assertThat(jdbc.queryForObject("""
            SELECT status FROM meeting_decisions WHERE id=?
            """, String.class, id)).isEqualTo("CONFIRMED");
    }

    @Test
    void decisionRevisionsAreAuditableAndCannotBeRewritten() {
        UUID decision = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_decisions(
                id,meeting_id,content,status,source_type,created_by_user_id,
                confirmed_by_user_id,confirmed_at)
            VALUES (?,?,'Original','CONFIRMED','MANUAL',?,?,CURRENT_TIMESTAMP)
            """, decision, source.meeting, actor, actor);
        UUID revision = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO decision_revisions(
                id,decision_id,revision_number,previous_content,new_content,edited_by_user_id)
            VALUES (?,?,1,'Original','Rewritten',?)
            """, revision, decision, actor);
        rejected(() -> jdbc.update("""
            INSERT INTO decision_revisions(
                id,decision_id,revision_number,previous_content,new_content,edited_by_user_id)
            VALUES (?,?,1,'Original','Duplicated',?)
            """, UUID.randomUUID(), decision, actor));
        rejected(() -> jdbc.update("""
            UPDATE decision_revisions SET new_content='tampered' WHERE id=?
            """, revision));
        assertThat(jdbc.queryForObject("""
            SELECT new_content FROM decision_revisions WHERE id=?
            """, String.class, revision)).isEqualTo("Rewritten");
    }
    @Test
    void aiSummaryCannotReferenceDecisionReceiptOrAnotherMeetingsParent() {
        UUID snap = snapshot(source);
        UUID decisions = receipt(source, snap, source.decisionStage, "DECISION_EXTRACTION");
        rejected(() -> summary(source, decisions, 1, false));

        // Parent IDs are meeting-scoped even when a UUID is known by a caller.
        UUID foreignSnap = snapshot(foreign);
        UUID foreignReceipt = receipt(foreign, foreignSnap, foreign.summaryStage, "SUMMARY");
        UUID foreignParent = summary(foreign, foreignReceipt, 1, true);
        rejected(() -> jdbc.update("""
            INSERT INTO meeting_summary_versions(
                id,meeting_id,version_number,content,source_type,based_on_summary_version_id,
                created_by_user_id,transcript_id,content_revision,quality_status)
            VALUES (?,?,1,'Forged parent','HUMAN_EDIT',?,?,?,2,'READY')
            """, UUID.randomUUID(), source.meeting, foreignParent, actor, source.transcript));
    }

    @Test
    void sourceBindingCannotBorrowAnotherJobSnapshotOrReceipt() {
        UUID foreignSnapshot = snapshot(foreign);
        rejected(() -> receipt(source, foreignSnapshot, source.summaryStage, "SUMMARY"));
        UUID snap = snapshot(source);
        UUID accepted = receipt(source, snap, source.decisionStage, "DECISION_EXTRACTION");
        rejected(() -> jdbc.update("""
            INSERT INTO meeting_decisions(
                id,meeting_id,content,status,source_type,processing_job_id,result_receipt_id,
                candidate_key,transcript_id,content_revision)
            VALUES (?,?,'Wrong source','PROPOSED','AI_EXTRACTED',?,?,?,?,2)
            """, UUID.randomUUID(), source.meeting, source.job, accepted,
            "candidate-wrong", foreign.transcript));
    }

    @Test
    void aiDecisionCannotStartConfirmedEvenWithAttributionAndCannotRepeatCandidate() {
        UUID snap = snapshot(source);
        UUID accepted = receipt(source, snap, source.decisionStage, "DECISION_EXTRACTION");
        UUID proposal = aiDecision(source, accepted);
        rejected(() -> jdbc.update("""
            INSERT INTO meeting_decisions(
                id,meeting_id,content,status,source_type,processing_job_id,result_receipt_id,
                candidate_key,transcript_id,content_revision,confirmed_by_user_id,confirmed_at)
            VALUES (?,?,'Untrusted confirmation','CONFIRMED','AI_EXTRACTED',?,?,?,?,?, ?,CURRENT_TIMESTAMP)
            """, UUID.randomUUID(), source.meeting, source.job, accepted,
            "candidate-2", source.transcript, 2, actor));
        rejected(() -> jdbc.update("""
            INSERT INTO meeting_decisions(
                id,meeting_id,content,status,source_type,processing_job_id,result_receipt_id,
                candidate_key,transcript_id,content_revision)
            VALUES (?,?,'Same candidate','PROPOSED','AI_EXTRACTED',?,?,?,?,?)
            """, UUID.randomUUID(), source.meeting, source.job, accepted,
            "candidate-1", source.transcript, 2));
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_decisions WHERE result_receipt_id=?
            """, Integer.class, accepted)).isEqualTo(1);
        assertThat(proposal).isNotNull();
    }

}
