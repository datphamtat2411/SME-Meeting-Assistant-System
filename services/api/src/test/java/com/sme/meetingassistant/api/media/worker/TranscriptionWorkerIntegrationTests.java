package com.sme.meetingassistant.api.media.worker;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import com.sme.meetingassistant.api.integration.TranscriptionWorkerCompletion;
import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycleService;
import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.node.ObjectNode;

/** Real PostgreSQL locks, constraints, migrations and commit/rollback; isolated S3 bytes. */
@ActiveProfiles("test")
@SpringBootTest(properties={"app.media.outbox.enabled=false","app.media.processing.stage-lease-sweep-ms=3600000"})
@Import(PostgresTestConfiguration.class)
class TranscriptionWorkerIntegrationTests {
    @Autowired TranscriptionWorkerService worker;
    @Autowired TranscriptionWorkerCompletion completion;
    @Autowired MediaRepository mediaRepository;
    @Autowired ProcessingJobLifecycleService lifecycle;
    @Autowired JdbcTemplate jdbc;
    @Autowired DeadLetterReconciliation reconciliation;
    @Autowired PlatformTransactionManager transactions;
    @MockitoBean ObjectStorage storage;
    @MockitoBean TranscriptionWorkerCapability capability;
    UUID actor,meeting,media,job,event;
    WorkerCommands.Claim claimCommand;
    @BeforeEach void seed() {
        when(capability.storageId()).thenReturn("meeting-private");
        actor=UUID.randomUUID(); meeting=UUID.randomUUID(); media=UUID.randomUUID(); job=UUID.randomUUID(); event=UUID.randomUUID();
        String email=actor+"@worker.invalid";
        jdbc.update("INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status) VALUES (?,?,?,'Worker test','test','EMPLOYEE','ACTIVE')",actor,email,email);
        jdbc.update("INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id) VALUES (?,'Worker test',?,?)",meeting,actor,actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,content_type,
                expected_size_bytes,size_bytes,duration_ms,sha256,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',1024,1024,1750,?,?,clock_timestamp())
            """,media,meeting,"meetings/"+meeting+"/sources/"+media,"pending/"+media,"a".repeat(64),actor);
        jdbc.update("INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status) VALUES (?,?,?,?,'PENDING')",job,meeting,media,actor);
        jdbc.update("INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status) VALUES (?,?,'CONTEXTUAL_CORRECTION',1,'PENDING')",UUID.randomUUID(),job);
        event(event,0);
        claimCommand=command(event,0);
    }
    void event(UUID id,int generation) {
        var payload=WorkerJson.MAPPER.createObjectNode().put("schemaVersion",generation==0?1:2).put("attemptNumber",generation);
        jdbc.update("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES (?,'PROCESSING_JOB',?,?,CAST(? AS jsonb))",
            id,job,generation==0?"PROCESSING_JOB_QUEUED":"PROCESSING_JOB_RETRY_REQUESTED",payload.toString());
    }
    WorkerCommands.Claim command(UUID e,int generation) {
        return new WorkerCommands.Claim(e,generation==0?"PROCESSING_JOB_QUEUED":"PROCESSING_JOB_RETRY_REQUESTED",generation==0?1:2,meeting,media,actor,generation,UUID.randomUUID());
    }
    WorkerCommands.Owner owner(Map<String,Object> c) {
        return new WorkerCommands.Owner((UUID)c.get("eventId"),(Integer)c.get("generation"),(UUID)c.get("executionStageRunId"),(UUID)c.get("claimToken"));
    }
    WorkerCommands.Complete corrected(Map<String,Object> claim,boolean warnings) throws Exception {
        var node=CorrectedTranscriptTests.fixture();
        node.put("processingJobId",job.toString()).put("sourceMediaId",media.toString()).put("producerStageRunId",claim.get("executionStageRunId").toString());
        if(warnings) {
            node.put("pipelineStatus","COMPLETED_WITH_WARNINGS");
            node.withArray("warnings").addObject().put("stage","CORRECTION").put("code","completed-with-warnings")
                .putNull("startSample").putNull("endSample").putNull("phase").putArray("sourceChunkIds");
        }
        byte[] bytes=WorkerJson.MAPPER.writeValueAsBytes(node);
        when(storage.head(anyString())).thenAnswer(i->{assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            return new ObjectStorage.StoredObject(bytes.length,"application/json","etag");});
        when(storage.readBounded(anyString(),anyInt())).thenAnswer(i->{assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();return bytes;});
        return new WorkerCommands.Complete(UUID.randomUUID(),owner(claim),WorkerJson.sha256(bytes),(UUID)claim.get("executionStageRunId"));
    }
    WorkerCommands.Fail failure(Map<String,Object> c,boolean partial) {
        return new WorkerCommands.Fail(UUID.randomUUID(),owner(c),"CORRECTION","PROVIDER",partial?"RECONCILIATION":null,
            partial?Map.of("sampleCount",28000L,"warningCount",0L,"unresolvedRegionCount",0L):Map.of());
    }
    int count(String table) { return jdbc.queryForObject("SELECT count(*) FROM "+table+" WHERE processing_job_id=?",Integer.class,job); }
    DeadLetterEvent deadEvent() {
        return new DeadLetterEvent(event,job,meeting,media,actor,0,"PROCESSING_JOB_QUEUED",1,null,"a".repeat(64));
    }
    @Test void exhaustedUnclaimedDeliveryCommitsFailureAndReplayWithoutInventingWorkerClaim() {
        assertThat(reconciliation.reconcile(deadEvent())).isEqualTo("EXHAUSTED");
        assertThat(worker.status(job,event)).containsEntry("state","FAILURE_RECORDED");
        assertThat(count("transcription_worker_claims")).isZero();
        assertThat(reconciliation.reconcile(deadEvent())).isEqualTo("EXHAUSTED");
        assertThat(count("transcription_worker_receipts")).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT error_code FROM processing_jobs WHERE id=?",String.class,job))
            .isEqualTo("WORKER_DELIVERY_EXHAUSTED");
    }
    @Test void liveDeliveryIsDurablyDeferredAndSweeperOutcomeIsPreserved() {
        var c=worker.claim(job,claimCommand);
        assertThat(reconciliation.reconcile(deadEvent())).isEqualTo("DEFERRED");
        assertThat(worker.status(job,event)).containsEntry("state","RUNNING");
        jdbc.update("UPDATE processing_stage_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=?",c.get("executionStageRunId"));
        lifecycle.expireAbandonedStages();
        assertThat(reconciliation.reconcile(deadEvent())).isEqualTo("TERMINAL");
        assertThat(jdbc.queryForObject("SELECT error_code FROM transcription_worker_receipts WHERE processing_job_id=?",String.class,job)).isEqualTo("STAGE_LEASE_EXPIRED");
    }
    @Test void acceptedAndNewerGenerationSurviveDeadLetter() throws Exception {
        var c=worker.claim(job,claimCommand); completion.complete(job,corrected(c,false));
        assertThat(reconciliation.reconcile(deadEvent())).isEqualTo("TERMINAL");
        assertThat(count("transcripts")).isEqualTo(1);
    }
    @Test void concurrentDeadLettersCreateOneDurableOutcome() throws Exception {
        var outcomes=race(()->reconciliation.reconcile(deadEvent()),()->reconciliation.reconcile(deadEvent()));
        assertThat(outcomes).containsOnly("EXHAUSTED");
        assertThat(count("transcription_worker_receipts")).isEqualTo(1);
    }
    @Test void unknownBindingAndContradictoryIdentityAreQuarantinedWithoutFailingJob() {
        var wrong=new DeadLetterEvent(event,job,meeting,UUID.randomUUID(),actor,0,"PROCESSING_JOB_QUEUED",1,null,"b".repeat(64));
        assertThat(reconciliation.reconcile(wrong)).isEqualTo("QUARANTINED");
        assertThat(count("transcription_worker_receipts")).isZero();
        assertThat(worker.status(job,event)).containsEntry("state","AVAILABLE");
        reconciliation.quarantine("c".repeat(64),"INVALID_ENVELOPE",12);
        reconciliation.quarantine("c".repeat(64),"INVALID_ENVELOPE",12);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM transcription_worker_quarantine WHERE evidence_sha256=?",Integer.class,"c".repeat(64))).isEqualTo(1);
    }
    @Test void dispositionFailureRollsBackExhaustion() {
        jdbc.execute("CREATE FUNCTION test_dlq_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END; $$");
        jdbc.execute("CREATE TRIGGER test_dlq_reject BEFORE INSERT ON transcription_worker_reconciliations FOR EACH ROW EXECUTE FUNCTION test_dlq_reject()");
        try {
            assertThatThrownBy(()->reconciliation.reconcile(deadEvent())).isInstanceOf(RuntimeException.class);
            assertThat(worker.status(job,event)).containsEntry("state","AVAILABLE");
            assertThat(count("transcription_worker_receipts")).isZero();
        } finally {
            jdbc.execute("DROP TRIGGER test_dlq_reject ON transcription_worker_reconciliations");
            jdbc.execute("DROP FUNCTION test_dlq_reject()");
        }
        assertThat(reconciliation.reconcile(deadEvent())).isEqualTo("EXHAUSTED");
    }
    @Test void deadLetterRetryBudgetIsFiniteAcrossFourAdmittedGenerations() {
        UUID current=event;
        for(int generation=0;generation<=3;generation++) {
            var delivery=new DeadLetterEvent(current,job,meeting,media,actor,generation,
                generation==0?"PROCESSING_JOB_QUEUED":"PROCESSING_JOB_RETRY_REQUESTED",generation==0?1:2,
                generation==0?null:"TRANSCRIPTION","d".repeat(64));
            assertThat(reconciliation.reconcile(delivery)).isEqualTo("EXHAUSTED");
            var receipt=(Map<?,?>)worker.status(job,current).get("receipt");
            assertThat(receipt.get("retryable")).isEqualTo(generation<3);
            assertThat(receipt.get("retryExhausted")).isEqualTo(generation==3);
            if(generation<3) {
                current=UUID.randomUUID();
                assertThat(mediaRepository.retryJobAndOutbox(mediaRepository.findJob(job).orElseThrow(),current,"TRANSCRIPTION",3)).isTrue();
            }
        }
        assertThat(count("transcription_worker_receipts")).isEqualTo(4);
        assertThat(mediaRepository.retryJobAndOutbox(mediaRepository.findJob(job).orElseThrow(),UUID.randomUUID(),"TRANSCRIPTION",3)).isFalse();
    }
    @Test void deadLetterCompletionAndSweeperRacesPreserveTheirAuthoritativeOutcome() throws Exception {
        var c=worker.claim(job,claimCommand); var cmd=corrected(c,false);
        race(()->completion.complete(job,cmd).get("state"),()->reconciliation.reconcile(deadEvent()));
        assertThat(reconciliation.reconcile(deadEvent())).isEqualTo("TERMINAL");
        assertThat(worker.status(job,event)).containsEntry("state","RESULT_ACCEPTED");
        assertThat(count("transcripts")).isEqualTo(1);
    }
    @Test void deadLetterRacingLeaseSweeperDoesNotReplaceExpiryReceipt() throws Exception {
        var c=worker.claim(job,claimCommand);
        jdbc.update("UPDATE processing_stage_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=?",c.get("executionStageRunId"));
        race(()->{lifecycle.expireAbandonedStages();return "swept";},()->reconciliation.reconcile(deadEvent()));
        // SKIP LOCKED legitimately lets this sweep miss the job if reconciliation
        // owns it. The next scheduled sweep, then durable recovery, must converge.
        assertThat(count("transcription_worker_reconciliations")).isEqualTo(1);
        lifecycle.expireAbandonedStages();
        new DeadLetterRecovery(jdbc,reconciliation).recover();
        assertThat(jdbc.queryForObject("SELECT disposition FROM transcription_worker_reconciliations WHERE event_id=?",String.class,event)).isEqualTo("TERMINAL");
        assertThat(jdbc.queryForObject("SELECT error_code FROM transcription_worker_receipts WHERE event_id=?",String.class,event)).isEqualTo("STAGE_LEASE_EXPIRED");
        assertThat(reconciliation.reconcile(deadEvent())).isEqualTo("TERMINAL");
    }
    @Test void lockedJobIsSkippedThenDurableDeferredRecoverySurvivesFreshInstance() {
        var c=worker.claim(job,claimCommand);
        jdbc.update("UPDATE processing_stage_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=?",c.get("executionStageRunId"));
        new TransactionTemplate(transactions).executeWithoutResult(tx->{
            jdbc.queryForObject("SELECT id FROM meetings WHERE id=? FOR UPDATE",UUID.class,meeting);
            jdbc.queryForObject("SELECT id FROM processing_jobs WHERE id=? FOR UPDATE",UUID.class,job);
            try(var pool=Executors.newSingleThreadExecutor()) {
                pool.submit(()->lifecycle.expireAbandonedStages()).get(10,TimeUnit.SECONDS);
            } catch(Exception failure) { throw new AssertionError(failure); }
            assertThat(count("transcription_worker_receipts")).isZero();
            assertThat(reconciliation.reconcile(deadEvent())).isEqualTo("DEFERRED");
        });
        assertThat(worker.status(job,event)).containsEntry("state","AWAITING_RECONCILIATION");
        assertThatThrownBy(()->worker.renew(job,owner(c))).hasMessage("WORKER_LEASE_LOST");
        // No broker redelivery or old process-local state is needed after commit.
        lifecycle.expireAbandonedStages();
        var receipt=worker.status(job,event).get("receipt");
        new DeadLetterRecovery(jdbc,reconciliation).recover();
        assertThat(reconciliation.reconcile(deadEvent())).isEqualTo("TERMINAL");
        new DeadLetterRecovery(jdbc,reconciliation).recover();
        assertThat(worker.status(job,event)).containsEntry("state","FAILURE_RECORDED").containsEntry("receipt",receipt);
        assertThat(count("transcription_worker_receipts")).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT retry_count FROM processing_jobs WHERE id=?",Integer.class,job)).isZero();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM outbox_events WHERE aggregate_id=?",Integer.class,job)).isEqualTo(1);
    }
    @Test void existingFailureReceiptWinsAcrossReconciliationReplay() {
        var c=worker.claim(job,claimCommand);
        var failed=worker.fail(job,failure(c,false));
        assertThat(reconciliation.reconcile(deadEvent())).isEqualTo("TERMINAL");
        assertThat(reconciliation.reconcile(deadEvent())).isEqualTo("TERMINAL");
        assertThat(worker.status(job,event)).containsEntry("receipt",failed.get("receipt"));
        assertThat(count("transcription_worker_receipts")).isEqualTo(1);
    }
    @Test void newerAdmissionWithoutOldReceiptIsPreserved() {
        jdbc.update("UPDATE processing_jobs SET retry_count=1 WHERE id=?",job);
        event(UUID.randomUUID(),1);
        assertThat(reconciliation.reconcile(deadEvent())).isEqualTo("SUPERSEDED");
        assertThat(count("transcription_worker_receipts")).isZero();
        assertThat(jdbc.queryForObject("SELECT status FROM processing_jobs WHERE id=?",String.class,job)).isEqualTo("PENDING");
    }
    @Test void claimReplayRenewAndCompetingOwnerAreFenced() {
        assertThat(worker.status(job,event).get("state")).isEqualTo("AVAILABLE");
        var c=worker.claim(job,claimCommand); var replay=worker.claim(job,claimCommand);
        assertThat(replay.get("claimToken")).isEqualTo(c.get("claimToken"));
        assertThat(c.get("leaseSeconds")).isEqualTo(120);
        assertThatThrownBy(()->worker.claim(job,command(event,0))).isInstanceOf(WorkerException.class).hasMessage("WORKER_ATTEMPT_BUSY");
        assertThat(worker.renew(job,owner(c))).containsKey("leaseExpiresAt");
        assertThat(worker.status(job,event)).doesNotContainKey("claimToken").containsEntry("state","RUNNING");
        jdbc.update("UPDATE processing_stage_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=?",c.get("executionStageRunId"));
        assertThatThrownBy(()->worker.renew(job,owner(c))).hasMessage("WORKER_LEASE_LOST");
        assertThatThrownBy(()->worker.claim(job,claimCommand)).hasMessage("WORKER_LEASE_LOST");
        assertThat(worker.status(job,event).get("state")).isEqualTo("AWAITING_RECONCILIATION");
        lifecycle.expireAbandonedStages();
        assertThat(worker.status(job,event).get("state")).isEqualTo("FAILURE_RECORDED");
        assertThat(worker.claim(job,claimCommand).get("state")).isEqualTo("FAILURE_RECORDED");
    }
    @Test void unknownAndConflictingAdmissionCannotClaim() {
        assertThatThrownBy(()->worker.claim(job,command(UUID.randomUUID(),0))).hasMessage("WORKER_DELIVERY_NOT_FOUND");
        var wrong=new WorkerCommands.Claim(event,"PROCESSING_JOB_QUEUED",1,meeting,UUID.randomUUID(),actor,0,UUID.randomUUID());
        assertThatThrownBy(()->worker.claim(job,wrong)).hasMessage("WORKER_IDENTITY_CONFLICT");
        assertThat(count("processing_stage_runs")).isEqualTo(1);
    }
    @Test void concurrentClaimsHaveExactlyOneOwner() throws Exception {
        var results=race(()->attemptClaim(command(event,0)),()->attemptClaim(command(event,0)));
        assertThat(results).containsExactlyInAnyOrder("claimed","WORKER_ATTEMPT_BUSY");
        assertThat(count("transcription_worker_claims")).isEqualTo(1);
    }
    String attemptClaim(WorkerCommands.Claim c) { try {worker.claim(job,c);return "claimed";}catch(WorkerException e){return e.code();} }
    @Test void commitsCanonicalTranscriptReceiptAndStagesAndReplaysAfterExpiry() throws Exception {
        var c=worker.claim(job,claimCommand); var cmd=corrected(c,false); var accepted=completion.complete(job,cmd);
        assertThat(accepted).containsEntry("state","RESULT_ACCEPTED").containsEntry("replay",false);
        assertThat(count("transcripts")).isEqualTo(1); assertThat(count("transcription_worker_receipts")).isEqualTo(1);
        assertThat(jdbc.queryForList("SELECT status FROM processing_stage_runs WHERE processing_job_id=?",String.class,job)).containsOnly("SUCCEEDED");
        jdbc.update("UPDATE processing_stage_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE processing_job_id=?",job);
        reset(storage);
        var replay=completion.complete(job,cmd);
        assertThat(replay.get("receipt")).isEqualTo(accepted.get("receipt")); assertThat(replay.get("replay")).isEqualTo(true);
        verifyNoInteractions(storage);
        var conflicting=new WorkerCommands.Complete(cmd.commandId(),cmd.owner(),"b".repeat(64),cmd.resultProducerStageRunId());
        assertThatThrownBy(()->completion.complete(job,conflicting)).isInstanceOf(WorkerException.class);
    }
    @Test void warningOnlyAcceptanceAndDownstreamPlanArePreserved() throws Exception {
        jdbc.update("INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status) VALUES (?,?,'GENERATING_SUMMARY',1,'PENDING')",UUID.randomUUID(),job);
        var c=worker.claim(job,claimCommand); completion.complete(job,corrected(c,true));
        assertThat(jdbc.queryForObject("SELECT status FROM transcripts WHERE processing_job_id=?",String.class,job)).isEqualTo("READY_WITH_WARNINGS");
        assertThat(jdbc.queryForObject("SELECT status FROM processing_jobs WHERE id=?",String.class,job)).isEqualTo("RUNNING");
        assertThat(jdbc.queryForObject("SELECT warning_count FROM transcription_worker_results WHERE processing_job_id=?",Integer.class,job)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT status FROM processing_stage_runs WHERE processing_job_id=? AND stage_code='FINALIZING_TRANSCRIPT'",String.class,job)).isEqualTo("SUCCEEDED_WITH_WARNING");
    }
    @Test void receiptFailureRollsBackCanonicalPublicationButKeepsVerifiedObjectReference() throws Exception {
        var c=worker.claim(job,claimCommand); var cmd=corrected(c,false);
        jdbc.execute("CREATE FUNCTION test_worker_receipt_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END; $$");
        jdbc.execute("CREATE TRIGGER test_worker_receipt_reject BEFORE INSERT ON transcription_worker_receipts FOR EACH ROW EXECUTE FUNCTION test_worker_receipt_reject()");
        try {
            assertThatThrownBy(()->completion.complete(job,cmd)).isInstanceOf(RuntimeException.class);
            assertThat(count("transcripts")).isZero(); assertThat(count("transcription_worker_receipts")).isZero();
            assertThat(count("transcription_worker_results")).isEqualTo(1);
            assertThat(worker.status(job,event).get("state")).isEqualTo("RUNNING");
            assertThat(count("processing_stage_runs")).isEqualTo(2);
        } finally { jdbc.execute("DROP TRIGGER test_worker_receipt_reject ON transcription_worker_receipts");jdbc.execute("DROP FUNCTION test_worker_receipt_reject()"); }
    }
    @Test void identicalConcurrentCompletionsReturnOneReceipt() throws Exception {
        var c=worker.claim(job,claimCommand); var cmd=corrected(c,false);
        var results=race(()->completion.complete(job,cmd),()->completion.complete(job,cmd));
        assertThat(results.get(0).get("receipt")).isEqualTo(results.get(1).get("receipt"));
        assertThat(count("transcripts")).isEqualTo(1); assertThat(count("transcription_worker_receipts")).isEqualTo(1);
    }
    @Test void finalizationFailureRollsBackUpstreamProjection() throws Exception {
        var c=worker.claim(job,claimCommand); var cmd=corrected(c,false);
        jdbc.execute("CREATE FUNCTION test_worker_transcript_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END; $$");
        jdbc.execute("CREATE TRIGGER test_worker_transcript_reject BEFORE INSERT ON transcripts FOR EACH ROW EXECUTE FUNCTION test_worker_transcript_reject()");
        try {
            assertThatThrownBy(()->completion.complete(job,cmd)).isInstanceOf(RuntimeException.class);
            assertThat(count("transcripts")).isZero();assertThat(count("transcription_worker_receipts")).isZero();
            assertThat(jdbc.queryForObject("SELECT status FROM processing_stage_runs WHERE id=?",String.class,c.get("executionStageRunId"))).isEqualTo("RUNNING");
        } finally {jdbc.execute("DROP TRIGGER test_worker_transcript_reject ON transcripts");jdbc.execute("DROP FUNCTION test_worker_transcript_reject()");}
    }
    @Test void acceptedReplayDoesNotOverwriteHumanChanges() throws Exception {
        var c=worker.claim(job,claimCommand);var cmd=corrected(c,false);completion.complete(job,cmd);
        jdbc.update("UPDATE transcript_segments SET current_text='Human correction',corrected_by_user_id=?,corrected_at=clock_timestamp() WHERE transcript_id=(SELECT id FROM transcripts WHERE processing_job_id=?)",actor,job);
        completion.complete(job,cmd);
        assertThat(jdbc.queryForList("SELECT current_text FROM transcript_segments WHERE transcript_id=(SELECT id FROM transcripts WHERE processing_job_id=?)",String.class,job)).containsOnly("Human correction");
    }
    @Test void staleResultAfterLeaseExpiryNeverPublishes() throws Exception {
        var c=worker.claim(job,claimCommand);var cmd=corrected(c,false);
        jdbc.update("UPDATE processing_stage_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=?",c.get("executionStageRunId"));
        assertThatThrownBy(()->completion.complete(job,cmd)).hasMessage("WORKER_LEASE_LOST");
        assertThat(count("transcripts")).isZero();assertThat(count("transcription_worker_receipts")).isZero();
    }
    @Test void completeFailRaceProducesOneOutcome() throws Exception {
        var c=worker.claim(job,claimCommand); var cmd=corrected(c,false); var fail=failure(c,false);
        race(()->{try{return completion.complete(job,cmd).get("state").toString();}catch(WorkerException e){return e.code();}},
            ()->{try{return worker.fail(job,fail).get("state").toString();}catch(WorkerException e){return e.code();}});
        assertThat(count("transcription_worker_receipts")).isEqualTo(1);
        String state=worker.status(job,event).get("state").toString();
        assertThat(count("transcripts")).isEqualTo(state.equals("RESULT_ACCEPTED")?1:0);
    }
    @Test void partialFailureRetainsTextFreeSuccessAndCorrectionRetry() throws Exception {
        var c=worker.claim(job,claimCommand); var f=failure(c,true);
        var receipt=worker.fail(job,f);
        assertThat(receipt.get("state")).isEqualTo("FAILURE_RECORDED");
        assertThat(worker.fail(job,f).get("receipt")).isEqualTo(receipt.get("receipt"));
        assertThat(count("transcripts")).isZero();
        assertThat(jdbc.queryForObject("SELECT status FROM processing_stage_runs WHERE id=?",String.class,c.get("executionStageRunId"))).isEqualTo("SUCCEEDED");
        var failed=mediaRepository.findJob(job).orElseThrow(); UUID next=UUID.randomUUID();
        assertThat(mediaRepository.retryJobAndOutbox(failed,next,"CONTEXTUAL_CORRECTION",3)).isTrue();
        var retry=worker.claim(job,command(next,1));
        assertThat(retry.get("executionStageCode")).isEqualTo("CONTEXTUAL_CORRECTION");
        assertThatThrownBy(()->worker.renew(job,owner(c))).hasMessage("WORKER_LEASE_LOST");
        completion.complete(job,corrected(retry,false));
        assertThat(count("transcripts")).isEqualTo(1);
    }
    @Test void retryBudgetExhaustionAndSweeperReceiptAreDurable() {
        var c=worker.claim(job,claimCommand);
        for(int gen=0;gen<=3;gen++) {
            var failed=worker.fail(job,failure(c,false));
            var receipt=(Map<?,?>)failed.get("receipt");
            assertThat(receipt.get("retryable")).isEqualTo(gen<3); assertThat(receipt.get("retryExhausted")).isEqualTo(gen==3);
            if(gen<3) {
                UUID next=UUID.randomUUID();
                assertThat(mediaRepository.retryJobAndOutbox(mediaRepository.findJob(job).orElseThrow(),next,"TRANSCRIPTION",3)).isTrue();
                c=worker.claim(job,command(next,gen+1));
            }
        }
        assertThat(mediaRepository.retryJobAndOutbox(mediaRepository.findJob(job).orElseThrow(),UUID.randomUUID(),"TRANSCRIPTION",3)).isFalse();
    }
    @Test void finalizationOnlyWithoutArtifactRecordsMissingAndPreservesSuccessfulStages() {
        var transcription=lifecycle.startStage(job,"TRANSCRIPTION",null,null);
        lifecycle.completeStage(transcription,"SUCCEEDED",null,"{\"speech_coverage_validated\":true}");
        var correction=lifecycle.startStage(job,"CONTEXTUAL_CORRECTION",null,null);
        lifecycle.completeStage(correction,"SUCCEEDED",null,"{\"contextScope\":\"WHOLE_MEETING\",\"promptVersion\":\"correction-v1\",\"outputSha256\":\"dfa8c6d7a8a5297c28f1b4f7f4fcea73a0c21b04fe4e3377a5b9ad29e9acb70a\"}");
        var c=worker.claim(job,claimCommand);
        assertThat(c.get("executionStageCode")).isEqualTo("FINALIZING_TRANSCRIPT");assertThat(c.get("reusableResult")).isNull();
        var receipt=worker.fail(job,new WorkerCommands.Fail(UUID.randomUUID(),owner(c),"PUBLICATION","NOT_FOUND",null,Map.of()));
        assertThat(((Map<?,?>)receipt.get("receipt")).get("errorCode")).isEqualTo("TRANSCRIPT_RESULT_MISSING");
        assertThat(jdbc.queryForObject("SELECT status FROM processing_stage_runs WHERE id=?",String.class,correction.stageRunId())).isEqualTo("SUCCEEDED");
        assertThat(count("transcripts")).isZero();
    }
    @Test void finalizationRetryReusesRegisteredOriginalProducerAndProof() throws Exception {
        var c=worker.claim(job,claimCommand);var cmd=corrected(c,false);
        var claim=worker.completionSource(job,cmd);
        byte[] bytes=storage.readBounded("test-fixture",CorrectedTranscript.MAX_BYTES);
        var result=CorrectedTranscript.validate(bytes,job,media,"a".repeat(64),cmd.resultProducerStageRunId(),cmd.resultSha256());
        worker.registerVerified(job,cmd,result,bytes.length);
        var original=new com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim(claim.stageId(),claim.token());
        lifecycle.completeStage(original,"SUCCEEDED",null,"{\"speech_coverage_validated\":true}");
        var correction=lifecycle.startStage(job,"CONTEXTUAL_CORRECTION",null,null);
        lifecycle.completeStage(correction,"SUCCEEDED",null,result.proofJson());
        var finalizer=lifecycle.startStage(job,"FINALIZING_TRANSCRIPT",null,null);
        lifecycle.failStage(finalizer,"TRANSCRIPT_RESULT_MISSING",null,true);
        UUID next=UUID.randomUUID();
        assertThat(mediaRepository.retryJobAndOutbox(mediaRepository.findJob(job).orElseThrow(),next,"FINALIZING_TRANSCRIPT",3)).isTrue();
        var retry=worker.claim(job,command(next,1));
        assertThat(retry.get("executionStageCode")).isEqualTo("FINALIZING_TRANSCRIPT");
        assertThat(((Map<?,?>)retry.get("reusableResult")).get("producerStageRunId")).isEqualTo(cmd.resultProducerStageRunId());
        var resumed=new WorkerCommands.Complete(UUID.randomUUID(),owner(retry),cmd.resultSha256(),cmd.resultProducerStageRunId());
        assertThat(completion.complete(job,resumed).get("state")).isEqualTo("RESULT_ACCEPTED");
        assertThat(jdbc.queryForObject("SELECT producer_stage_run_id FROM transcription_worker_receipts WHERE processing_job_id=?",UUID.class,job)).isEqualTo(cmd.resultProducerStageRunId());
    }
    private static <T> List<T> race(Callable<T> a,Callable<T> b) throws Exception {
        var gate=new CountDownLatch(1);
        try(var pool=Executors.newFixedThreadPool(2)) {
            var first=pool.submit(()->{gate.await();return a.call();}); var second=pool.submit(()->{gate.await();return b.call();});
            gate.countDown(); return List.of(first.get(20,TimeUnit.SECONDS),second.get(20,TimeUnit.SECONDS));
        }
    }
}
