package com.sme.meetingassistant.api.media.intelligence;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.sme.meetingassistant.api.integration.TranscriptFinalizationService;
import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.service.*;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceResultIngestion;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.transcript.service.TranscriptCorrectionDigest;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.*;
import java.nio.file.*;
import java.time.OffsetDateTime;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.support.*;

/** Fake executor, real admission/finalization/receipt/lease/outbox transactions. */
@ActiveProfiles("test")
@SpringBootTest(properties={"app.media.outbox.enabled=false",
    "app.media.processing.stage-lease-sweep-ms=3600000"})
@Import(PostgresTestConfiguration.class)
class IntelligenceWorkerIntegrationTests {
    static final String PEER="a".repeat(64), OTHER="b".repeat(64);
    @Autowired JdbcTemplate jdbc;
    @org.springframework.test.context.bean.override.mockito.MockitoSpyBean MediaRepository repository;
    @Autowired ProcessingJobLifecycle lifecycle;
    @Autowired ProcessingJobLifecycleService recovery;
    @Autowired TranscriptFinalizationService finalization;
    @Autowired IntelligenceWorkerService worker;
    @Autowired IntelligenceResultIngestion ingestion;
    @Autowired MediaProperties properties;
    @Autowired TransactionTemplate transactions;
    @Autowired com.sme.meetingassistant.api.media.diarization.DiarizationWorkerService diarizationWorker;
    @Autowired com.sme.meetingassistant.api.media.diarization.DiarizationCompletion diarizationCompletion;
    @MockitoBean ObjectStorage storage;
    @MockitoBean IntelligenceWorkerCapability capability;
    @MockitoBean com.sme.meetingassistant.api.media.diarization.DiarizationWorkerCapability diarizationCapability;
    final Map<String,byte[]> blobs=new ConcurrentHashMap<>();
    UUID actor,meeting,media,job;

    @BeforeEach void setup() throws Exception {
        blobs.clear();
        // Each fixture owns its own delivery. Keep previous fixtures' pending
        // notifications out of this test's bounded fake-publisher batch.
        jdbc.update("UPDATE outbox_events SET next_attempt_at=clock_timestamp()+interval '1 hour' WHERE status='PENDING'");
        properties.getProcessing().setMaxRetries(3);
        properties.getProcessing().setActionItemHandoffEnabled(false);
        properties.getIntelligence().setEnabled(true);
        properties.getIntelligence().setDispatchEnabled(true);
        properties.getIntelligence().setEnabledStages(IntelligenceWorkerCapability.ORDER);
        when(capability.canDispatch(anyString())).thenReturn(true);
        when(capability.storageId()).thenReturn("meeting-media");
        when(diarizationCapability.storageId()).thenReturn("meeting-media");
        when(storage.putAcceptedIfAbsent(anyString(),any(Path.class),anyString())).thenAnswer(c->{
            outsideTransaction();return blobs.putIfAbsent(c.getArgument(0),Files.readAllBytes(c.getArgument(1)))==null;
        });
        when(storage.head(anyString())).thenAnswer(c->{
            outsideTransaction();var bytes=Objects.requireNonNull(blobs.get((String)c.getArgument(0)));
            return new ObjectStorage.StoredObject(bytes.length,"application/json",null);
        });
        when(storage.readBounded(anyString(),anyInt())).thenAnswer(c->{
            outsideTransaction();return Objects.requireNonNull(blobs.get((String)c.getArgument(0))).clone();
        });
        doAnswer(c->{outsideTransaction();Files.write(c.getArgument(1),blobs.get((String)c.getArgument(0)));return null;})
            .when(storage).downloadTo(anyString(),any(Path.class));
        doAnswer(c->{outsideTransaction();blobs.remove((String)c.getArgument(0));return null;}).when(storage).delete(anyString());
        actor=UUID.randomUUID();meeting=UUID.randomUUID();media=UUID.randomUUID();job=UUID.randomUUID();
        jdbc.update("INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status) VALUES (?,?,?,'AIMI','test','EMPLOYEE','ACTIVE')",actor,actor+"@aimi.invalid",actor+"@aimi.invalid");
        jdbc.update("INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id) VALUES (?,'AIMI',?,?)",meeting,actor,actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,content_type,
                expected_size_bytes,size_bytes,duration_ms,sha256,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',1024,1024,10000,?,?,CURRENT_TIMESTAMP)
            """,media,meeting,"meetings/"+meeting+"/sources/"+media,"meetings/"+meeting+"/pending/"+media,"c".repeat(64),actor);
    }
    static void outsideTransaction() { assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse(); }
    void admit(String... stages) {
        transactions.executeWithoutResult(tx->repository.insertJobAndOutbox(new MediaRepository.Job(
            job,meeting,media,"OFFLINE_MEETING_PROCESSING","PENDING",actor,null,0,null,null,null,
            null,null,null,OffsetDateTime.now(),OffsetDateTime.now()),UUID.randomUUID(),List.of(stages)));
    }
    TranscriptResult result(UUID producer) {
        return new TranscriptResult(meeting,media,job,producer,"vi",10000L,Status.READY,
            List.of(new SegmentResult(0,100,1200,"Thống nhất kế hoạch thực hiện.","ACCEPTED",null,producer,null)),
            List.of(new CoverageResult(100,1200,"COVERED",false,0,null)),List.of());
    }
    void finalizeSource() {
        var asr=lifecycle.startStage(job,"TRANSCRIPTION",null,null);lifecycle.completeStage(asr,"SUCCEEDED",null,null);
        var correction=lifecycle.startStage(job,"CONTEXTUAL_CORRECTION",null,null);
        lifecycle.completeStage(correction,"SUCCEEDED",null,"{\"contextScope\":\"WHOLE_MEETING\",\"outputSha256\":\""+TranscriptCorrectionDigest.sha256(result(correction.stageRunId()))+"\",\"promptVersion\":\"aimi-v1\"}");
        var stage=lifecycle.startStage(job,"FINALIZING_TRANSCRIPT",null,null);
        finalization.finalizeTranscript(stage,result(stage.stageRunId()));
    }
    UUID event(String stage) {return jdbc.queryForObject("SELECT event_id FROM processing_intelligence_dispatches WHERE processing_job_id=? AND stage_code=? ORDER BY created_at DESC LIMIT 1",UUID.class,job,stage);}
    UUID attempt(String stage) {return jdbc.queryForObject("SELECT id FROM processing_stage_runs WHERE processing_job_id=? AND stage_code=? ORDER BY attempt_number DESC LIMIT 1",UUID.class,job,stage);}
    IntelligenceCommands.Claim command(String stage) {return new IntelligenceCommands.Claim(event(stage),"PROCESSING_INTELLIGENCE_STAGE_REQUESTED",1,attempt(stage),stage,UUID.randomUUID());}
    IntelligenceCommands.Owner owner(IntelligenceCommands.Claim c,Map<String,Object> data) {return new IntelligenceCommands.Owner(c.eventId(),c.executionStageRunId(),(UUID)data.get("claimToken"));}
    String jobStatus() {return repository.findJob(job).orElseThrow().status();}
    long count(String table) {return jdbc.queryForObject("SELECT count(*) FROM "+table+" WHERE processing_job_id=?",Long.class,job);}
    void accept(IntelligenceCommands.Owner owner,String stage) {
        var source=jdbc.queryForMap("SELECT * FROM meeting_intelligence_source_snapshots WHERE processing_job_id=?",job);
        String type=stage.equals("GENERATING_SUMMARY")?"SUMMARY":"DECISION_EXTRACTION";
        String result=type.equals("SUMMARY")?"{\"content\":\"Kế hoạch đã được thống nhất.\",\"warnings\":[]}":"{\"candidates\":[],\"warnings\":[]}";
        var bytes=WorkerJson.MAPPER.writeValueAsBytes(Map.of("schemaVersion","1.0","resultType",type,
            "processingJobId",job,"stageRunId",owner.executionStageRunId(),"source",Map.of("transcriptId",source.get("transcript_id"),
            "contentRevision",source.get("content_revision"),"inputSnapshotId",source.get("id"),"sha256",source.get("sha256")),
            "producer",Map.of("model","test-executor","promptVersion","v1"),"result",WorkerJson.MAPPER.readTree(result)));
        blobs.put("processing/"+job+"/intelligence/results/"+owner.executionStageRunId()+".json",bytes);
        assertThat(ingestion.ingest(new StageClaim(owner.executionStageRunId(),owner.claimToken()),WorkerJson.sha256(bytes)).replay()).isFalse();
    }

    @Test void finalizedSourceDispatchesOrderedSubsetAndCanonicalFinalAcceptanceCompletesJob() {
        admit("EXTRACTING_DECISIONS","GENERATING_SUMMARY");
        assertThat(count("processing_intelligence_dispatches")).isZero();
        finalizeSource();
        assertThat(count("processing_intelligence_dispatches")).isEqualTo(1);
        var summary=command("GENERATING_SUMMARY");
        var data=worker.claim(job,summary,PEER);var owner=owner(summary,data);
        assertThat(data).containsKeys("source","resultSlot","leaseExpiresAt","renewAfterSeconds");
        assertThat(WorkerJson.MAPPER.writeValueAsString(data)).doesNotContain("Thống nhất kế hoạch");
        assertThatThrownBy(()->lifecycle.completeStage(new StageClaim(owner.executionStageRunId(),owner.claimToken()),"SUCCEEDED",null,null)).isInstanceOf(RuntimeException.class);
        worker.renew(job,owner,PEER);
        accept(owner,"GENERATING_SUMMARY");
        assertThat(jobStatus()).isEqualTo("RUNNING");
        assertThat(worker.status(job,summary.eventId())).containsEntry("state","RESULT_ACCEPTED").containsEntry("acknowledge",true).doesNotContainKey("claimToken");
        var decision=command("EXTRACTING_DECISIONS");
        accept(owner(decision,worker.claim(job,decision,PEER)),"EXTRACTING_DECISIONS");
        assertThat(jobStatus()).isEqualTo("COMPLETED");
        assertThat(count("meeting_intelligence_result_receipts")).isEqualTo(2);
        assertThat(count("processing_intelligence_dispatches")).isEqualTo(2);
        verify(storage,times(1)).putAcceptedIfAbsent(anyString(),any(Path.class),anyString());
    }
    @Test void duplicateAndCompetingCommandsNeverDiscloseOrReplaceLiveOwnership() throws Exception {
        admit("GENERATING_SUMMARY");finalizeSource();var c=command("GENERATING_SUMMARY");
        var first=worker.claim(job,c,PEER);var owner=owner(c,first);
        assertThat(worker.claim(job,c,PEER).get("claimToken")).isEqualTo(owner.claimToken());
        assertThatThrownBy(()->worker.claim(job,c,OTHER)).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(()->worker.claim(job,command("GENERATING_SUMMARY"),PEER)).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(()->worker.renew(job,owner,OTHER)).isInstanceOf(RuntimeException.class);
        assertThat(count("processing_intelligence_claims")).isEqualTo(1);
        accept(owner,"GENERATING_SUMMARY");
        assertThat(worker.claim(job,c,OTHER)).containsEntry("acknowledge",true).doesNotContainKey("claimToken");
        var key="processing/"+job+"/intelligence/results/"+owner.executionStageRunId()+".json";
        assertThat(ingestion.ingest(new StageClaim(owner.executionStageRunId(),owner.claimToken()),WorkerJson.sha256(blobs.get(key))).replay()).isTrue();
        assertThat(count("meeting_intelligence_result_receipts")).isEqualTo(1);
    }
    @Test void concurrentClaimersHaveExactlyOneWinner() throws Exception {
        admit("EXTRACTING_DECISIONS");finalizeSource();var a=command("EXTRACTING_DECISIONS");var b=command("EXTRACTING_DECISIONS");
        try(var pool=Executors.newFixedThreadPool(2)) {
            var gate=new CountDownLatch(1);
            var f=pool.submit(()->{gate.await();try {worker.claim(job,a,PEER);return true;}catch(RuntimeException conflict){return false;}});
            var g=pool.submit(()->{gate.await();try {worker.claim(job,b,OTHER);return true;}catch(RuntimeException conflict){return false;}});
            gate.countDown();assertThat(List.of(f.get(20,TimeUnit.SECONDS),g.get(20,TimeUnit.SECONDS))).containsExactlyInAnyOrder(true,false);
        }
        assertThat(count("processing_intelligence_claims")).isEqualTo(1);
    }
    @Test void failureRetryIsNewIntelligenceAttemptAndPreservesEarlierCanonicalSummary() {
        admit("GENERATING_SUMMARY","EXTRACTING_DECISIONS");finalizeSource();var s=command("GENERATING_SUMMARY");accept(owner(s,worker.claim(job,s,PEER)),"GENERATING_SUMMARY");
        var c=command("EXTRACTING_DECISIONS");var o=owner(c,worker.claim(job,c,PEER));
        var failure=new IntelligenceCommands.Fail(UUID.randomUUID(),o,"INFERENCE","TIMEOUT");
        assertThat(worker.fail(job,failure,PEER)).containsEntry("state","FAILURE_RECORDED").containsEntry("acknowledge",true);
        assertThat(worker.fail(job,failure,PEER)).containsEntry("acknowledge",true);
        assertThat(jobStatus()).isEqualTo("FAILED");
        var failed=repository.findJob(job).orElseThrow();
        transactions.executeWithoutResult(tx->assertThat(repository.retryJobAndOutbox(failed,UUID.randomUUID(),null,3)).isTrue());
        var retry=command("EXTRACTING_DECISIONS");
        assertThat(retry.executionStageRunId()).isNotEqualTo(c.executionStageRunId());
        assertThat(worker.status(job,c.eventId())).containsEntry("state","SUPERSEDED");
        assertThatThrownBy(()->worker.renew(job,o,PEER)).isInstanceOf(RuntimeException.class);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM outbox_events WHERE aggregate_id=? AND event_type='PROCESSING_JOB_RETRY_REQUESTED'",Long.class,job)).isZero();
        accept(owner(retry,worker.claim(job,retry,PEER)),"EXTRACTING_DECISIONS");
        assertThat(jobStatus()).isEqualTo("COMPLETED");
        assertThat(jdbc.queryForObject("SELECT count(*) FROM meeting_summary_versions WHERE processing_job_id=?",Long.class,job)).isEqualTo(1);
    }
    @Test void expiredClaimRequiresReconciliationAndCannotBeReclaimedByEventReplay() {
        admit("GENERATING_SUMMARY");finalizeSource();var c=command("GENERATING_SUMMARY");var o=owner(c,worker.claim(job,c,PEER));
        jdbc.update("UPDATE processing_stage_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=?",o.executionStageRunId());
        assertThat(worker.status(job,c.eventId())).containsEntry("state","AWAITING_RECONCILIATION").containsEntry("acknowledge",false);
        assertThatThrownBy(()->worker.claim(job,c,PEER)).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(()->worker.renew(job,o,PEER)).isInstanceOf(RuntimeException.class);
        recovery.expireAbandonedStages();
        assertThat(worker.status(job,c.eventId())).containsEntry("state","FAILURE_RECORDED").containsEntry("acknowledge",true);
        assertThat(jobStatus()).isEqualTo("FAILED");
    }
    @Test void corruptSnapshotOrSourceChangeDuringIoNeverIssuesAClaim() throws Exception {
        admit("GENERATING_SUMMARY");finalizeSource();var c=command("GENERATING_SUMMARY");
        doAnswer(call->{outsideTransaction();return new byte[]{1};}).when(storage).readBounded(anyString(),anyInt());
        assertThatThrownBy(()->worker.claim(job,c,PEER)).isInstanceOf(RuntimeException.class);
        assertThat(count("processing_intelligence_claims")).isZero();
        doAnswer(call->{
            outsideTransaction();jdbc.update("UPDATE transcripts SET content_revision=content_revision+1 WHERE processing_job_id=?",job);
            return blobs.get((String)call.getArgument(0));
        }).when(storage).readBounded(anyString(),anyInt());
        assertThatThrownBy(()->worker.claim(job,c,PEER)).isInstanceOf(RuntimeException.class);
        assertThat(count("processing_intelligence_claims")).isZero();
    }
    @Test void invalidDispatchIdentityIsRejectedBeforeAnySnapshotIo() {
        admit("GENERATING_SUMMARY");finalizeSource();var c=command("GENERATING_SUMMARY");
        var forged=new IntelligenceCommands.Claim(c.eventId(),c.eventType(),1,c.executionStageRunId(),"EXTRACTING_DECISIONS",c.claimRequestId());
        assertThatThrownBy(()->worker.claim(job,forged,PEER)).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(()->worker.claim(UUID.randomUUID(),c,PEER)).isInstanceOf(RuntimeException.class);
        verifyNoInteractions(storage);
        assertThatThrownBy(()->lifecycle.startStage(job,"EXTRACTING_DECISIONS",null,null)).isInstanceOf(RuntimeException.class);
    }
    @Test void failedPublicationIsObservableRetryableAndCannotOverwriteAlreadyClaimedProgress() {
        admit("GENERATING_SUMMARY");finalizeSource();var c=command("GENERATING_SUMMARY");
        var events=repository.claimPendingOutbox(25,60,1);var notification=events.stream().filter(e->e.id().equals(c.eventId())).findFirst().orElseThrow();
        repository.markPublishFailed(notification.id(),notification.claimToken(),1,1,"TimeoutException");
        recovery.expireAbandonedStages();assertThat(jobStatus()).isEqualTo("FAILED");
        assertThat(worker.status(job,c.eventId())).containsEntry("acknowledge",true);
    }
    @Test void latePublisherFailureCannotFailClaimedAttemptAndUnclaimedPublishedDeliveryIsBoundedlyReconciled() {
        admit("GENERATING_SUMMARY");finalizeSource();var c=command("GENERATING_SUMMARY");
        var events=repository.claimPendingOutbox(25,60,1);var notification=events.stream().filter(e->e.id().equals(c.eventId())).findFirst().orElseThrow();
        worker.claim(job,c,PEER);repository.markPublishFailed(notification.id(),notification.claimToken(),1,1,"TimeoutException");
        recovery.expireAbandonedStages();assertThat(jobStatus()).isEqualTo("RUNNING");
        assertThat(worker.status(job,c.eventId())).containsEntry("state","RUNNING");
    }
    @Test void publishedUnclaimedDeliveryTimesOutWithoutAnAutomaticExecutionRetry() {
        admit("GENERATING_SUMMARY");finalizeSource();var c=command("GENERATING_SUMMARY");
        var notifications=repository.claimPendingOutbox(25,60,3);
        for(var event:notifications) repository.markPublished(event.id(),event.claimToken());
        jdbc.update("UPDATE outbox_events SET published_at=clock_timestamp()-interval '2 hours' WHERE id=?",c.eventId());
        recovery.expireAbandonedStages();
        assertThat(jobStatus()).isEqualTo("FAILED");assertThat(count("processing_intelligence_dispatches")).isEqualTo(1);
        assertThat(worker.claim(job,c,PEER)).containsEntry("acknowledge",true).doesNotContainKey("claimToken");
    }
    @Test void optionalDiarizationFailureContinuesAndPendingIndexingStillBlocksCompletion() {
        admit("DIARIZING","EXTRACTING_DECISIONS","INDEXING");finalizeSource();
        assertThat(count("processing_intelligence_dispatches")).isZero();
        var diarization=lifecycle.startStage(job,"DIARIZING",null,null);
        lifecycle.failStage(diarization,"DIARIZATION_FAILED",null,true);
        var c=command("EXTRACTING_DECISIONS");accept(owner(c,worker.claim(job,c,PEER)),"EXTRACTING_DECISIONS");
        assertThat(jobStatus()).isEqualTo("RUNNING");
        assertThatThrownBy(()->lifecycle.completeJob(job)).isInstanceOf(RuntimeException.class);
    }
    @Test void canonicalDiarizationAcceptanceDispatchesIntelligenceOnlyAfterSpeakerProjection() {
        admit("DIARIZING","GENERATING_SUMMARY");finalizeSource();
        UUID diarization=attempt("DIARIZING");
        UUID event=jdbc.queryForObject("SELECT event_id FROM processing_diarization_dispatches WHERE stage_run_id=?",UUID.class,diarization);
        var data=diarizationWorker.claim(job,new com.sme.meetingassistant.api.media.diarization.DiarizationCommands.Claim(
            event,"PROCESSING_DIARIZATION_REQUESTED",1,meeting,media,diarization,UUID.randomUUID()));
        UUID transcript=jdbc.queryForObject("SELECT id FROM transcripts WHERE processing_job_id=?",UUID.class,job);
        var result=WorkerJson.MAPPER.createObjectNode().put("contractVersion","1.0").put("resultType","DIARIZATION_RESULT")
            .put("processingJobId",job.toString()).put("sourceMediaId",media.toString()).put("sourceRevision","c".repeat(64))
            .put("transcriptId",transcript.toString()).put("transcriptRevision",0).put("producerStageRunId",diarization.toString())
            .put("modelId","test/diarizer").put("status","COMPLETED");
        result.putArray("speakerLabels").add("SPEAKER_01");
        result.putArray("turns").addObject().put("startMs",100).put("endMs",1200).put("speakerLabel","SPEAKER_01");
        result.putArray("assignments").addObject().put("ordinal",0).put("speakerLabel","SPEAKER_01");
        result.putObject("diagnostics").put("unknownAssignmentCount",0);
        byte[] bytes=WorkerJson.MAPPER.writeValueAsBytes(result);
        blobs.put(com.sme.meetingassistant.api.media.diarization.DiarizationWorkerRepository.resultKey(job,diarization),bytes);
        var owner=new com.sme.meetingassistant.api.media.diarization.DiarizationCommands.Owner(event,diarization,(UUID)data.get("claimToken"));
        diarizationCompletion.complete(job,new com.sme.meetingassistant.api.media.diarization.DiarizationCommands.Complete(UUID.randomUUID(),owner,WorkerJson.sha256(bytes),diarization));
        assertThat(count("processing_intelligence_dispatches")).isEqualTo(1);
        var summary=command("GENERATING_SUMMARY");worker.claim(job,summary,PEER);
        assertThat(jdbc.queryForObject("SELECT content_revision FROM meeting_intelligence_source_snapshots WHERE processing_job_id=?",Long.class,job)).isEqualTo(1);
    }
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings={"EXTRACTING_ACTION_ITEMS","GENERATING_SUMMARY,EXTRACTING_ACTION_ITEMS","GENERATING_SUMMARY,EXTRACTING_DECISIONS,EXTRACTING_ACTION_ITEMS"})
    void actionItemStageCannotSucceedWithoutItsFeatureOwnedCanonicalProposalReceipt(String plan) {
        properties.getProcessing().setActionItemHandoffEnabled(true);
        var stages=plan.split(",");admit(stages);finalizeSource();
        for(String stage:stages) if(!"EXTRACTING_ACTION_ITEMS".equals(stage)) {
            var command=command(stage);accept(owner(command,worker.claim(job,command,PEER)),stage);
        }
        var c=command("EXTRACTING_ACTION_ITEMS");
        var data=worker.claim(job,c,PEER);var o=owner(c,data);
        assertThat(data).doesNotContainKey("resultSlot");
        assertThatThrownBy(()->lifecycle.completeStage(new StageClaim(o.executionStageRunId(),o.claimToken()),"SUCCEEDED",null,null)).isInstanceOf(RuntimeException.class);
        assertThat(jobStatus()).isEqualTo("RUNNING");assertThat(count("meeting_intelligence_result_receipts")).isEqualTo(stages.length-1);
    }
    @Test void dispatchIdentityCannotBeChangedAfterRegistration() {
        admit("GENERATING_SUMMARY");finalizeSource();var c=command("GENERATING_SUMMARY");
        assertThatThrownBy(()->jdbc.update("UPDATE processing_intelligence_dispatches SET schema_version=2 WHERE event_id=?",c.eventId())).isInstanceOf(RuntimeException.class);
        assertThatThrownBy(()->jdbc.update("UPDATE outbox_events SET payload=jsonb_set(payload,'{executionStageCode}','\"EXTRACTING_DECISIONS\"') WHERE id=?",c.eventId())).isInstanceOf(RuntimeException.class);
    }
    @Test void skippedIntelligenceWithoutCanonicalEvidenceCannotCompleteAndAdmittedIdentityCannotBeRemoved() {
        when(capability.canDispatch(anyString())).thenReturn(false);
        admit("GENERATING_SUMMARY");finalizeSource();UUID planned=attempt("GENERATING_SUMMARY");
        assertThatThrownBy(()->jdbc.update("DELETE FROM processing_stage_runs WHERE id=?",planned)).isInstanceOf(RuntimeException.class);
        jdbc.update("UPDATE processing_stage_runs SET status='SKIPPED' WHERE id=?",planned);
        assertThatThrownBy(()->lifecycle.completeJob(job)).isInstanceOf(RuntimeException.class);
        assertThat(jobStatus()).isEqualTo("RUNNING");
    }
    @Test void dispatchAndAcceptanceProgressionRollBackTogether() {
        admit("GENERATING_SUMMARY","EXTRACTING_DECISIONS");finalizeSource();var c=command("GENERATING_SUMMARY");var o=owner(c,worker.claim(job,c,PEER));
        doThrow(new IllegalStateException("simulated outbox persistence failure")).when(repository)
            .dispatchIntelligenceStage(eq(job),any(UUID.class),eq("EXTRACTING_DECISIONS"),any(UUID.class));
        assertThatThrownBy(()->accept(o,"GENERATING_SUMMARY")).isInstanceOf(RuntimeException.class);
        assertThat(count("meeting_intelligence_result_receipts")).isZero();
        assertThat(count("processing_intelligence_dispatches")).isEqualTo(1);
        assertThat(worker.status(job,c.eventId())).containsEntry("state","RUNNING");
    }
    @Test void recoveryRestoresMissingEligibleDispatchButNeverSkipsFailedWork() {
        when(capability.canDispatch(anyString())).thenReturn(false);
        admit("GENERATING_SUMMARY","EXTRACTING_DECISIONS");finalizeSource();assertThat(count("processing_intelligence_dispatches")).isZero();
        when(capability.canDispatch(anyString())).thenReturn(true);recovery.expireAbandonedStages();recovery.expireAbandonedStages();
        assertThat(count("processing_intelligence_dispatches")).isEqualTo(1);
        var c=command("GENERATING_SUMMARY");var o=owner(c,worker.claim(job,c,PEER));worker.fail(job,new IntelligenceCommands.Fail(UUID.randomUUID(),o,"INFERENCE","CONFIGURATION"),PEER);
        recovery.expireAbandonedStages();assertThat(count("processing_intelligence_dispatches")).isEqualTo(1);
    }
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(booleans={false,true})
    void migrationPreservesExistingPlansAndDoesNotInventDispatchesForHistoricalAttempts(boolean derived) {
        admit("GENERATING_SUMMARY");String schema="aimi_"+UUID.randomUUID().toString().replace("-","");
        try {
            org.flywaydb.core.Flyway.configure().dataSource(jdbc.getDataSource()).schemas(schema).defaultSchema(schema)
                .locations("classpath:db/migration").target("44").load().migrate();
            jdbc.update("INSERT INTO "+schema+".users SELECT * FROM public.users WHERE id=?",actor);
            jdbc.update("INSERT INTO "+schema+".meetings SELECT * FROM public.meetings WHERE id=?",meeting);
            jdbc.update("INSERT INTO "+schema+".meeting_media SELECT * FROM public.meeting_media WHERE id=?",media);
            jdbc.update("INSERT INTO "+schema+".processing_jobs SELECT * FROM public.processing_jobs WHERE id=?",job);
            if(derived) jdbc.update("UPDATE "+schema+".processing_jobs SET job_type='DERIVED_STAGE_PROCESSING' WHERE id=?",job);
            jdbc.update("INSERT INTO "+schema+".processing_stage_runs SELECT * FROM public.processing_stage_runs WHERE processing_job_id=?"
                +(derived?" AND stage_code='GENERATING_SUMMARY'":""),job);
            UUID legacy=UUID.randomUUID();
            String payload=WorkerJson.MAPPER.writeValueAsString(new MediaRepository.JobQueuedEvent(
                legacy,job,meeting,media,actor,null,1,OffsetDateTime.now()));
            transactions.executeWithoutResult(tx->{
                // Legacy V27 triggers resolve their unqualified tables through
                // the connection's deployment schema, just as a real upgrade does.
                jdbc.execute("SET LOCAL search_path TO "+schema);
                jdbc.update("INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,occurred_at) VALUES (?,'PROCESSING_JOB',?,'PROCESSING_JOB_QUEUED',CAST(? AS jsonb),clock_timestamp())",legacy,job,payload);
            });
            var upgraded=org.flywaydb.core.Flyway.configure().dataSource(jdbc.getDataSource()).schemas(schema).defaultSchema(schema)
                .locations("classpath:db/migration").load();
            assertThat(upgraded.migrate().migrationsExecuted).isEqualTo(1);upgraded.validate();
            assertThat(jdbc.queryForObject("SELECT count(*) FROM "+schema+".processing_stage_runs WHERE processing_job_id=?",Long.class,job)).isEqualTo(derived?1:2);
            assertThat(jdbc.queryForObject("SELECT count(*) FROM "+schema+".processing_intelligence_dispatches",Long.class)).isZero();
            assertThat(jdbc.queryForObject("SELECT status FROM "+schema+".outbox_events WHERE id=?",String.class,legacy)).isEqualTo(derived?"FAILED":"PENDING");
        } finally {jdbc.execute("DROP SCHEMA IF EXISTS "+schema+" CASCADE");}
    }
}
