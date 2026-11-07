package com.sme.meetingassistant.api.actionitems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.actionitem.service.ActionItemBatchFingerprint;
import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink;
import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink.Batch;
import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink.Candidate;
import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink.Receipt;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.meetingintelligence.service.ActionItemProposalHandoff;
import com.sme.meetingassistant.api.meetingintelligence.service.ActionItemProposalHandoff.SourceReference;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.time.LocalDate;
import java.util.Map;
import java.security.Principal;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.Future;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.IllegalTransactionStateException;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;

/**
 * AI-03: acceptance against the REAL Action Items sink, PostgreSQL/MI
 * snapshot/Media stage. Unlike isolated MI-10 port tests, the sink is not mocked.
 * Each test uses committed fixtures; concurrency uses separate DB transactions.
 */
@ActiveProfiles("test")
@SpringBootTest(properties = {
    "app.media.outbox.enabled=false",
    "app.media.processing.stage-lease-sweep-ms=3600000",
    "app.media.processing.action-item-handoff-enabled=true"
})
@Import(PostgresTestConfiguration.class)
@AutoConfigureMockMvc
class ActionItemProposalSinkIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired ActionItemProposalSink sink;
    @Autowired ActionItemProposalHandoff handoff;
    @Autowired ProcessingJobLifecycle mediaLifecycle;
    @Autowired PlatformTransactionManager transactionManager;
    @Autowired ObjectMapper mapper;
    @Autowired MockMvc mvc;

    private UUID actor, meeting, media, job, transcript, segment, snapshot, stage;
    private UUID claimToken;
    private SourceReference source;

    @BeforeEach
    void setup() {
        actor=UUID.randomUUID();
        meeting=UUID.randomUUID();
        media=UUID.randomUUID();
        job=UUID.randomUUID();
        transcript=UUID.randomUUID();
        segment=UUID.randomUUID();
        snapshot=UUID.randomUUID();
        stage=UUID.randomUUID();
        claimToken=UUID.randomUUID();

        String email="ai03-"+actor+"@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'AI03 user','test-only','EMPLOYEE','ACTIVE')
            """, actor,email,email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Action extraction integration',?,?)
            """, meeting,actor,actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,10000,?,CURRENT_TIMESTAMP)
            """, media,meeting,"meetings/"+meeting+"/sources/"+media,
            "meetings/"+meeting+"/pending/"+media,actor);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status)
            VALUES (?,?,?,?,'RUNNING')
            """,job,meeting,media,actor);
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,version_number,
                language_code,status,is_current,content_revision)
            VALUES (?,?,?,?,1,'vi','READY',TRUE,3)
            """,transcript,meeting,media,job);
        jdbc.update("""
            INSERT INTO transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,current_text,quality_status)
            VALUES (?,?,0,0,1000,'Submit the quarterly report','ACCEPTED')
            """, segment,transcript);
        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(
                id,meeting_id,source_media_id,processing_job_id,transcript_id,
                content_revision,sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,3,?,?,100)
            """,snapshot,meeting,media,job,transcript,"a".repeat(64),
            "processing/"+job+"/intelligence/source/"+snapshot+".json");
        jdbc.update("""
            INSERT INTO processing_stage_runs(
                id,processing_job_id,stage_code,attempt_number,status,claim_token,lease_expires_at)
            VALUES (?,?,'EXTRACTING_ACTION_ITEMS',1,'RUNNING',?,CURRENT_TIMESTAMP+INTERVAL '1 hour')
            """,stage,job,claimToken);
        source=new SourceReference(snapshot,transcript,3,"a".repeat(64));
    }

    private StageClaim claim() { return new StageClaim(stage,claimToken); }

    private List<Candidate> candidates() {
        return List.of(new Candidate("action-1","Gửi báo cáo quý",
            "Hoàn thành bản dự thảo trước hạn",LocalDate.parse("2026-11-08"),
            List.of(segment)));
    }

    private Batch batch(List<Candidate> candidates) {
        return new Batch(meeting,job,stage,snapshot,transcript,3,false,
            ActionItemBatchFingerprint.sha256(mapper,candidates),candidates);
    }

    private Receipt accept(Batch batch) {
        return new TransactionTemplate(transactionManager).execute(tx -> sink.acceptProposed(batch));
    }

    private int proposalCount() {
        return jdbc.queryForObject("""
            SELECT count(*) FROM action_items WHERE meeting_id=? AND source_type='AI_EXTRACTED'
            """,Integer.class,meeting);
    }

    private int receiptCount() {
        return jdbc.queryForObject("""
            SELECT count(*) FROM action_item_batch_receipts WHERE processing_job_id=?
            """,Integer.class,job);
    }

    private UUID soleItem() {
        return jdbc.queryForObject("""
            SELECT id FROM action_items WHERE meeting_id=? AND source_type='AI_EXTRACTED'
            """,UUID.class,meeting);
    }

    @Test
    void realHandoffCommitsReceiptProposalEvidenceAndMediaCompletionAtomically() {
        assertThatThrownBy(() -> mediaLifecycle.completeStage(claim(),"SUCCEEDED",null,null))
            .isInstanceOf(RuntimeException.class);
        assertThat(handoff.handoff(claim(),source,candidates())).isEqualTo(new Receipt(false,1));
        assertThat(sink.hasAcceptedBatch(job,stage)).isTrue();
        assertThat(receiptCount()).isEqualTo(1);
        assertThat(proposalCount()).isEqualTo(1);
        UUID item=soleItem();
        assertThat(jdbc.queryForObject("SELECT status FROM action_items WHERE id=?",
            String.class,item)).isEqualTo("PROPOSED");
        assertThat(jdbc.queryForObject("SELECT assignee_user_id FROM action_items WHERE id=?",
            UUID.class,item)).isNull();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM action_item_evidence
             WHERE action_item_id=? AND transcript_id=? AND transcript_segment_id=?
            """,Integer.class,item,transcript,segment)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM action_item_history
             WHERE action_item_id=? AND change_type='STATUS' AND to_value='PROPOSED'
               AND changed_by_user_id IS NULL
            """,Integer.class,item)).isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT status FROM processing_stage_runs WHERE id=?",String.class,stage))
            .isEqualTo("SUCCEEDED");
    }

    @Test
    void emptyExtractionStillCommitsReceiptAndCompletesStage() {
        assertThat(handoff.handoff(claim(),source,List.of())).isEqualTo(new Receipt(false,0));
        assertThat(receiptCount()).isEqualTo(1);
        assertThat(proposalCount()).isZero();
        assertThat(jdbc.queryForObject("""
            SELECT candidate_count FROM action_item_batch_receipts WHERE stage_run_id=?
            """,Integer.class,stage)).isZero();
        assertThat(sink.hasAcceptedBatch(job,stage)).isTrue();
        assertThat(jdbc.queryForObject(
            "SELECT status FROM processing_stage_runs WHERE id=?",String.class,stage))
            .isEqualTo("SUCCEEDED");
    }

    @Test
    void historicalSnapshotCanProduceStaleProposalWithoutOfficialAssignment() {
        jdbc.update("UPDATE transcripts SET content_revision=4 WHERE id=?",transcript);
        assertThat(handoff.handoff(claim(),source,candidates())).isEqualTo(new Receipt(false,1));
        assertThat(jdbc.queryForObject("""
            SELECT is_stale FROM action_item_batch_receipts WHERE stage_run_id=?
            """,Boolean.class,stage)).isTrue();
        assertThat(jdbc.queryForObject("""
            SELECT content_revision FROM action_items WHERE id=?
            """,Long.class,soleItem())).isEqualTo(3L);
        assertThat(jdbc.queryForObject(
            "SELECT assignee_user_id FROM action_items WHERE id=?",UUID.class,soleItem()))
            .isNull();
    }

    @Test
    void exactReplayDoesNotOverwriteHumanEditsOrCreateDuplicateHistory() {
        Batch original=batch(candidates());
        assertThat(accept(original)).isEqualTo(new Receipt(false,1));
        UUID item=soleItem();
        jdbc.update("""
            UPDATE action_items
                SET title='Human confirmed business task',status='OPEN',
                    assignee_user_id=?,confirmed_by_user_id=?,confirmed_at=CURRENT_TIMESTAMP,
                    version=version+1
              WHERE id=?
            """,actor,actor,item);
        Batch changedStaleness=new Batch(meeting,job,stage,snapshot,transcript,3,true,
            original.batchSha256(),original.candidates());
        assertThat(accept(changedStaleness)).isEqualTo(new Receipt(true,0));
        assertThat(receiptCount()).isEqualTo(1);
        assertThat(proposalCount()).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT title FROM action_items WHERE id=?",
            String.class,item)).isEqualTo("Human confirmed business task");
        assertThat(jdbc.queryForObject("SELECT status FROM action_items WHERE id=?",
            String.class,item)).isEqualTo("OPEN");
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM action_item_history WHERE action_item_id=?
            """,Integer.class,item)).isEqualTo(1);
    }

    @Test
    void divergentReplayRejectsEvenIfCandidateCountIsIdentical() {
        assertThat(accept(batch(candidates()))).isEqualTo(new Receipt(false,1));
        List<Candidate> different=List.of(new Candidate("action-1","Nội dung khác",
            null,null,List.of(segment)));
        assertThatThrownBy(() -> accept(batch(different)))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("Divergent Action Item batch");
        assertThat(receiptCount()).isEqualTo(1);
        assertThat(proposalCount()).isEqualTo(1);
    }

    @Test
    void forgedDigestFailsClosedBeforeWritingReceipt() {
        Batch valid=batch(candidates());
        Batch forged=new Batch(meeting,job,stage,snapshot,transcript,3,false,
            "f".repeat(64),valid.candidates());
        assertThatThrownBy(() -> accept(forged))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("fingerprint");
        assertThat(receiptCount()).isZero();
        assertThat(proposalCount()).isZero();
    }

    @Test
    void invalidEvidenceRollsBackEntireReceiptAndProposalBatch() {
        List<Candidate> invalid=List.of(new Candidate("bad","Broken evidence",
            null,null,List.of(UUID.randomUUID())));
        assertThatThrownBy(() -> accept(batch(invalid)))
            .isInstanceOf(DataIntegrityViolationException.class);
        assertThat(receiptCount()).isZero();
        assertThat(proposalCount()).isZero();
    }

    @Test
    void forcedMediaFailureRollsBackPreviouslyInsertedCanonicalReceiptAndProposals() {
        Batch request=batch(candidates());
        assertThatThrownBy(() -> new TransactionTemplate(transactionManager).execute(tx -> {
            assertThat(sink.acceptProposed(request)).isEqualTo(new Receipt(false,1));
            assertThat(sink.hasAcceptedBatch(job,stage)).isTrue();
            // Force Media's real lease-fencing check to reject completion AFTER
            // Action Items has written all its data in this transaction.
            jdbc.update("""
                UPDATE processing_stage_runs
                   SET lease_expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second'
                 WHERE id=?
                """,stage);
            mediaLifecycle.completeStage(claim(),"SUCCEEDED",null,null);
            return null;
        })).isInstanceOf(RuntimeException.class);
        assertThat(receiptCount()).isZero();
        assertThat(proposalCount()).isZero();
        assertThat(jdbc.queryForObject(
            "SELECT status FROM processing_stage_runs WHERE id=?",String.class,stage))
            .isEqualTo("RUNNING");
    }

    @Test
    void staleOrForgedStageAndSourceCannotCreateCanonicalReceipts() {
        jdbc.update("""
            UPDATE processing_stage_runs SET lease_expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second'
             WHERE id=?
            """,stage);
        assertThatThrownBy(() -> accept(batch(candidates())))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("live stage");
        assertThat(receiptCount()).isZero();
        assertThat(proposalCount()).isZero();
    }

    @Test
    void correctNewAttemptCanReuseCandidateKeyWithoutOverwritingEarlierAttempt() {
        Batch first=batch(candidates());
        assertThat(accept(first)).isEqualTo(new Receipt(false,1));
        UUID firstItem=soleItem();
        // Previous attempt has already failed; the retry is a distinct stage run.
        jdbc.update("UPDATE processing_stage_runs SET status='FAILED' WHERE id=?",stage);
        UUID secondStage=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,
                attempt_number,status,claim_token,lease_expires_at)
            VALUES (?,?,'EXTRACTING_ACTION_ITEMS',2,'RUNNING',?,CURRENT_TIMESTAMP+INTERVAL '1 hour')
            """,secondStage,job,UUID.randomUUID());
        Batch retry=new Batch(meeting,job,secondStage,snapshot,transcript,3,false,
            first.batchSha256(),first.candidates());
        assertThat(accept(retry)).isEqualTo(new Receipt(false,1));
        assertThat(receiptCount()).isEqualTo(2);
        assertThat(proposalCount()).isEqualTo(2);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM action_items
             WHERE meeting_id=? AND source_item_key='action-1'
            """,Integer.class,meeting)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT id FROM action_items WHERE id=?",
            UUID.class,firstItem)).isEqualTo(firstItem);
    }

    @Test
    void concurrentIdenticalDeliveryProducesOnlyOneBusinessBatch() throws Exception {
        Batch request=batch(candidates());
        var pool=Executors.newFixedThreadPool(2);
        CountDownLatch ready=new CountDownLatch(2),start=new CountDownLatch(1);
        try {
            java.util.concurrent.Callable<Receipt> send=() -> {
                ready.countDown();
                if (!start.await(10,TimeUnit.SECONDS)) throw new IllegalStateException("Start gate timeout");
                return accept(request);
            };
            Future<Receipt> a=pool.submit(send), b=pool.submit(send);
            assertThat(ready.await(10,TimeUnit.SECONDS)).isTrue();
            start.countDown();
            var results=List.of(a.get(30,TimeUnit.SECONDS),b.get(30,TimeUnit.SECONDS));
            assertThat(results).containsExactlyInAnyOrder(new Receipt(false,1),new Receipt(true,0));
            assertThat(receiptCount()).isEqualTo(1);
            assertThat(proposalCount()).isEqualTo(1);
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM action_item_evidence WHERE action_item_id=?",
                Integer.class,soleItem())).isEqualTo(1);
        } finally {
            start.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void sinkRequiresExistingTransactionAndDoesNotOpenAnIndependentCommit() {
        assertThatThrownBy(() -> sink.acceptProposed(batch(candidates())))
            .isInstanceOf(IllegalTransactionStateException.class);
        assertThat(receiptCount()).isZero();
    }
    /** AI-06: one non-mocked chain crosses MI, Media, Transcript, Action Items and HTTP. */
    @Test
    void pinnedTranscriptToHumanReviewToOutsideAssigneeCompletionIsOneAuditedLineage()
            throws Exception {
        UUID external=UUID.randomUUID();
        String email="ai06-official-"+external+"@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'External assignee','test-only','EMPLOYEE','ACTIVE')
            """,external,email,email);

        assertThat(handoff.handoff(claim(),source,candidates())).isEqualTo(new Receipt(false,1));
        UUID task=soleItem();
        assertThat(receiptCount()).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT status FROM processing_stage_runs WHERE id=?",
            String.class,stage)).isEqualTo("SUCCEEDED");
        assertThat(jdbc.queryForObject("""
            SELECT source_snapshot_id FROM action_item_batch_receipts WHERE stage_run_id=?
            """,UUID.class,stage)).isEqualTo(snapshot);

        Principal organizer=() -> actor.toString(), outside=() -> external.toString();
        MvcResult proposal=mvc.perform(get("/api/v1/action-items/{id}",task)
                .principal(organizer)).andExpect(status().isOk()).andReturn();
        String proposedTag=proposal.getResponse().getHeader(HttpHeaders.ETAG);
        JsonNode proposed=mapper.readTree(proposal.getResponse().getContentAsString()).path("data");
        assertThat(proposed.path("status").asText()).isEqualTo("PROPOSED");
        assertThat(proposed.path("assigneeUserId").isNull()).isTrue();

        mvc.perform(post("/api/v1/action-items/{id}/confirm",task)
                .principal(organizer).header(HttpHeaders.IF_MATCH,proposedTag))
            .andExpect(status().isUnprocessableEntity());
        mvc.perform(get("/api/v1/action-items/{id}",task)
                .principal(outside)).andExpect(status().isNotFound());

        MvcResult assigned=mvc.perform(patch("/api/v1/action-items/{id}",task)
                .principal(organizer).header(HttpHeaders.IF_MATCH,proposedTag)
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(Map.of("assigneeUserId",external))))
            .andExpect(status().isOk()).andReturn();
        mvc.perform(get("/api/v1/action-items/{id}",task)
                .principal(outside)).andExpect(status().isNotFound());

        MvcResult confirmed=mvc.perform(post("/api/v1/action-items/{id}/confirm",task)
                .principal(organizer)
                .header(HttpHeaders.IF_MATCH,assigned.getResponse().getHeader(HttpHeaders.ETAG)))
            .andExpect(status().isOk()).andReturn();
        JsonNode accepted=mapper.readTree(confirmed.getResponse().getContentAsString()).path("data");
        assertThat(accepted.path("status").asText()).isEqualTo("OPEN");
        assertThat(accepted.path("confirmedByUserId").asText()).isEqualTo(actor.toString());

        MvcResult outsiderDetail=mvc.perform(get("/api/v1/action-items/{id}",task)
                .principal(outside)).andExpect(status().isOk()).andReturn();
        JsonNode restricted=mapper.readTree(outsiderDetail.getResponse().getContentAsString())
            .path("data");
        assertThat(restricted.path("title").asText()).isEqualTo("Gửi báo cáo quý");
        assertThat(restricted.path("processingJobId").isNull()).isTrue();
        assertThat(restricted.path("confirmedByUserId").isNull()).isTrue();
        mvc.perform(get("/api/v1/meetings/{id}",meeting).principal(outside))
            .andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/action-items/{id}",task).principal(()->UUID.randomUUID().toString()))
            .andExpect(status().isNotFound());

        MvcResult complete=mvc.perform(post("/api/v1/action-items/{id}/complete",task)
                .principal(outside)
                .header(HttpHeaders.IF_MATCH,outsiderDetail.getResponse().getHeader(HttpHeaders.ETAG)))
            .andExpect(status().isOk()).andReturn();
        assertThat(mapper.readTree(complete.getResponse().getContentAsString())
            .path("data").path("status").asText()).isEqualTo("DONE");
        assertThat(jdbc.queryForObject("""
            SELECT completed_by_user_id FROM action_items WHERE id=?
            """,UUID.class,task)).isEqualTo(external);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM action_item_history WHERE action_item_id=?
                AND change_type='STATUS'
            """,Integer.class,task)).isEqualTo(3);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM action_item_history WHERE action_item_id=?
                AND change_type='ASSIGNEE' AND changed_by_user_id=?
            """,Integer.class,task,actor)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM action_item_evidence
             WHERE action_item_id=? AND transcript_id=? AND transcript_segment_id=?
            """,Integer.class,task,transcript,segment)).isEqualTo(1);
        assertThat(receiptCount()).isEqualTo(1);
        assertThat(proposalCount()).isEqualTo(1);
    }

    @Test
    void warningQualityEvidenceCanProduceUnassignedProposalButNeverOfficialWorkAutomatically()
            throws Exception {
        jdbc.update("UPDATE transcripts SET status='READY_WITH_WARNINGS' WHERE id=?",transcript);
        jdbc.update("UPDATE transcript_segments SET quality_status='SUSPICIOUS' WHERE id=?",segment);
        assertThat(handoff.handoff(claim(),source,candidates())).isEqualTo(new Receipt(false,1));
        UUID item=soleItem();
        assertThat(jdbc.queryForObject(
            "SELECT status FROM action_items WHERE id=?",String.class,item)).isEqualTo("PROPOSED");
        assertThat(jdbc.queryForObject(
            "SELECT assignee_user_id FROM action_items WHERE id=?",UUID.class,item)).isNull();
        assertThat(jdbc.queryForObject(
            "SELECT confirmed_by_user_id FROM action_items WHERE id=?",UUID.class,item)).isNull();
        Principal user=()->actor.toString();
        MvcResult proposed=mvc.perform(get("/api/v1/action-items/{id}",item)
                .principal(user)).andExpect(status().isOk()).andReturn();
        mvc.perform(post("/api/v1/action-items/{id}/confirm",item)
                .principal(user)
                .header(HttpHeaders.IF_MATCH,proposed.getResponse().getHeader(HttpHeaders.ETAG)))
            .andExpect(status().isUnprocessableEntity());
        assertThat(jdbc.queryForObject(
            "SELECT status FROM processing_stage_runs WHERE id=?",String.class,stage))
            .isEqualTo("SUCCEEDED");
        assertThat(jdbc.queryForObject(
            "SELECT status FROM action_items WHERE id=?",String.class,item)).isEqualTo("PROPOSED");
    }

    @Test
    void multiCandidateBatchWithLateForeignEvidenceMustRollbackEarlierCandidateAndReceipt() {
        List<Candidate> list=List.of(
            new Candidate("first","Valid first proposed task",null,null,List.of(segment)),
            new Candidate("second","Bad second evidence",null,null,List.of(UUID.randomUUID())));
        assertThatThrownBy(() -> accept(batch(list)))
            .isInstanceOf(DataIntegrityViolationException.class);
        assertThat(receiptCount()).isZero();
        assertThat(proposalCount()).isZero();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM action_item_history WHERE action_item_id IN
                (SELECT id FROM action_items WHERE processing_job_id=?)
            """,Integer.class,job)).isZero();
        assertThat(jdbc.queryForObject(
            "SELECT status FROM processing_stage_runs WHERE id=?",String.class,stage))
            .isEqualTo("RUNNING");
    }

    @Test
    void liveMediaClaimAndPinnedSnapshotAreBothRequiredBeforeDurableHandoff() {
        SourceReference wrongHash=new SourceReference(snapshot,transcript,3,"f".repeat(64));
        assertThatThrownBy(() -> handoff.handoff(claim(),wrongHash,candidates()))
            .isInstanceOf(IllegalArgumentException.class);
        StageClaim stolen=new StageClaim(stage,UUID.randomUUID());
        assertThatThrownBy(() -> handoff.handoff(stolen,source,candidates()))
            .isInstanceOf(RuntimeException.class);
        assertThat(receiptCount()).isZero();
        assertThat(proposalCount()).isZero();
        assertThat(jdbc.queryForObject(
            "SELECT status FROM processing_stage_runs WHERE id=?",String.class,stage))
            .isEqualTo("RUNNING");
    }

    @Test
    void notReadyTranscriptCannotBeUsedForActionItemExtraction() {
        jdbc.update("UPDATE transcripts SET status='PROCESSING' WHERE id=?",transcript);
        assertThatThrownBy(() -> handoff.handoff(claim(),source,candidates()))
            .isInstanceOf(IllegalArgumentException.class);
        assertThat(receiptCount()).isZero();
        assertThat(proposalCount()).isZero();
        assertThat(jdbc.queryForObject(
            "SELECT status FROM processing_stage_runs WHERE id=?",String.class,stage))
            .isEqualTo("RUNNING");
    }

}
