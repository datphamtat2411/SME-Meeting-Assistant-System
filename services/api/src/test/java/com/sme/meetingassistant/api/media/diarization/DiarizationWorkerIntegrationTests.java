package com.sme.meetingassistant.api.media.diarization;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import com.sme.meetingassistant.api.integration.TranscriptFinalizationService;
import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycleService;
import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.transcript.service.TranscriptCorrectionDigest;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import tools.jackson.databind.node.ObjectNode;

@ActiveProfiles("test")
@SpringBootTest(properties={"app.media.outbox.enabled=false","app.media.processing.stage-lease-sweep-ms=3600000"})
@Import(PostgresTestConfiguration.class)
class DiarizationWorkerIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired MediaProperties properties;
    @Autowired MediaRepository mediaRepository;
    @Autowired ProcessingJobLifecycle lifecycle;
    @Autowired ProcessingJobLifecycleService sweeper;
    @Autowired TranscriptFinalizationService finalization;
    @Autowired DiarizationWorkerService worker;
    @Autowired DiarizationCompletion completion;
    @Autowired TransactionTemplate transactions;
    @Autowired com.sme.meetingassistant.api.media.service.ProcessingTranscriptEvidence transcriptEvidence;
    @MockitoBean ObjectStorage storage;
    @MockitoBean DiarizationWorkerCapability capability;
    UUID actor,meeting,media,job,event,stage,transcript;
    DiarizationCommands.Claim request;
    DiarizationCommands.Owner owner;

    @BeforeEach void fixture() {
        properties.getProcessing().setMaxRetries(2);
        when(capability.storageId()).thenReturn("meeting-media");
        actor=UUID.randomUUID();meeting=UUID.randomUUID();media=UUID.randomUUID();job=UUID.randomUUID();
        jdbc.update("INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status) VALUES (?,?,?,'SPK08','test','EMPLOYEE','ACTIVE')",actor,actor+"@spk08.invalid",actor+"@spk08.invalid");
        jdbc.update("INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id) VALUES (?,'SPK08',?,?)",meeting,actor,actor);
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,content_type,
              expected_size_bytes,size_bytes,duration_ms,sha256,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',1024,1024,10000,?,?,CURRENT_TIMESTAMP)
            """,media,meeting,"meetings/"+meeting+"/sources/"+media,"meetings/"+meeting+"/pending/"+media,"a".repeat(64),actor);
        jdbc.update("INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status,diarization_planned) VALUES (?,?,?,?,'PENDING',TRUE)",job,meeting,media,actor);
        stage=UUID.randomUUID();
        jdbc.update("INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status) VALUES (?,?,'DIARIZING',1,'PENDING')",stage,job);
        var asr=lifecycle.startStage(job,"TRANSCRIPTION",null,null); lifecycle.completeStage(asr,"SUCCEEDED",null,null);
        var correction=lifecycle.startStage(job,"CONTEXTUAL_CORRECTION",null,null);
        var draft=result(correction.stageRunId());
        lifecycle.completeStage(correction,"SUCCEEDED",null,"{\"contextScope\":\"WHOLE_MEETING\",\"outputSha256\":\""+TranscriptCorrectionDigest.sha256(draft)+"\",\"promptVersion\":\"spk08\"}");
        var finalizer=lifecycle.startStage(job,"FINALIZING_TRANSCRIPT",null,null);
        finalization.finalizeTranscript(finalizer,result(finalizer.stageRunId()));
        transcript=jdbc.queryForObject("SELECT id FROM transcripts WHERE processing_job_id=?",UUID.class,job);
        event=jdbc.queryForObject("SELECT event_id FROM processing_diarization_dispatches WHERE stage_run_id=?",UUID.class,stage);
        request=new DiarizationCommands.Claim(event,"PROCESSING_DIARIZATION_REQUESTED",1,meeting,media,stage,UUID.randomUUID());
    }
    private TranscriptResult result(UUID producer) {
        return new TranscriptResult(meeting,media,job,producer,"vi",10000L,Status.READY,
            List.of(new SegmentResult(7,100,1200,"PRIVATE CORRECTED TEXT","ACCEPTED",null,producer,null)),
            List.of(new CoverageResult(100,1200,"COVERED",false,0,null)),List.of());
    }
    protected Map<String,Object> claim() {
        var data=worker.claim(job,request);
        owner=new DiarizationCommands.Owner(event,stage,(UUID)data.get("claimToken"));return data;
    }
    protected ObjectNode artifact() {
        var n=WorkerJson.MAPPER.createObjectNode().put("contractVersion","1.0").put("resultType","DIARIZATION_RESULT")
            .put("processingJobId",job.toString()).put("sourceMediaId",media.toString()).put("sourceRevision","a".repeat(64))
            .put("transcriptId",transcript.toString()).put("transcriptRevision",0).put("producerStageRunId",stage.toString())
            .put("modelId","test/diarizer-v1").put("status","COMPLETED");
        n.putArray("speakerLabels").add("SPEAKER_01");
        n.putArray("turns").addObject().put("startMs",100).put("endMs",1200).put("speakerLabel","SPEAKER_01");
        n.putArray("assignments").addObject().put("ordinal",7).put("speakerLabel","SPEAKER_01");
        n.putObject("diagnostics").put("unknownAssignmentCount",0);return n;
    }
    protected DiarizationCommands.Complete upload(ObjectNode n) throws Exception {
        byte[] bytes=WorkerJson.MAPPER.writeValueAsBytes(n);String key=DiarizationWorkerRepository.resultKey(job,stage);
        when(storage.head(key)).thenAnswer(call->{assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();return new ObjectStorage.StoredObject(bytes.length,"application/json",null);});
        when(storage.readBounded(key,16777216)).thenAnswer(call->{assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();return bytes;});
        return new DiarizationCommands.Complete(UUID.randomUUID(),owner,WorkerJson.sha256(bytes),stage);
    }
    protected long count(String table) { return jdbc.queryForObject("SELECT count(*) FROM "+table+" WHERE processing_job_id=?",Long.class,job); }
    protected String stageStatus() {return jdbc.queryForObject("SELECT status FROM processing_stage_runs WHERE id=?",String.class,stage);}
    protected void expire() {jdbc.update("UPDATE processing_stage_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=?",stage);}
    private void conflict(Runnable action) { assertThatThrownBy(action::run).isInstanceOf(WorkerException.class); }

    @Test void duplicateClaimsRecoverOnlyOriginalOwnerAndAuthoritativeTextFreeSnapshot() {
        var first=claim();assertThat(worker.claim(job,request).get("claimToken")).isEqualTo(owner.claimToken());
        conflict(()->worker.claim(job,new DiarizationCommands.Claim(event,request.eventType(),1,meeting,media,stage,UUID.randomUUID())));
        conflict(()->worker.claim(job,new DiarizationCommands.Claim(event,request.eventType(),1,UUID.randomUUID(),media,stage,request.claimRequestId())));
        conflict(()->worker.claim(UUID.randomUUID(),request));
        var snapshot=worker.snapshot(job,owner);
        assertThat(WorkerJson.MAPPER.valueToTree(snapshot).toString()).contains("\"ordinal\":7","\"startMs\":100","\"endMs\":1200").doesNotContain("PRIVATE","speaker","participant","text");
        assertThat(first.toString()).doesNotContain("PRIVATE","https:","secretKey");
        assertThat(count("diarization_worker_claims")).isEqualTo(1);
        conflict(()->worker.snapshot(job,new DiarizationCommands.Owner(event,stage,UUID.randomUUID())));
        jdbc.update("UPDATE transcripts SET content_revision=1 WHERE id=?",transcript);
        conflict(()->worker.snapshot(job,owner));conflict(()->worker.claim(job,request));
    }
    @Test void concurrentClaimsHaveExactlyOneOwnerAndNoAdditionalAttempt() throws Exception {
        try(var pool=Executors.newFixedThreadPool(2)) {
            var gate=new CountDownLatch(1);
            Callable<Boolean> action=()->{gate.await();try {worker.claim(job,new DiarizationCommands.Claim(event,request.eventType(),1,meeting,media,stage,UUID.randomUUID()));return true;}catch(WorkerException busy){return false;}};
            var a=pool.submit(action);var b=pool.submit(action);gate.countDown();
            assertThat(List.of(a.get(20,TimeUnit.SECONDS),b.get(20,TimeUnit.SECONDS))).containsExactlyInAnyOrder(true,false);
        }
        assertThat(count("diarization_worker_claims")).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM processing_stage_runs WHERE processing_job_id=? AND stage_code='DIARIZING'",Long.class,job)).isEqualTo(1);
    }
    @Test void verificationIsDurableIdempotentNonterminalAndCannotBypassProjection() throws Exception {
        claim();var cmd=upload(artifact());var response=completion.complete(job,cmd);
        assertThat(response.get("state")).isEqualTo("RESULT_VERIFIED");assertThat(response.get("acknowledge")).isEqualTo(false);
        assertThat(completion.complete(job,cmd)).isEqualTo(response);
        assertThat(count("diarization_worker_verifications")).isEqualTo(1);assertThat(count("diarization_worker_receipts")).isZero();
        assertThat(stageStatus()).isEqualTo("RUNNING");
        assertThatThrownBy(()->lifecycle.completeStage(new ProcessingJobLifecycle.StageClaim(stage,owner.claimToken()),"SUCCEEDED",null,null)).isInstanceOf(MediaRepository.ProcessingLifecycleConflictException.class);
        assertThatThrownBy(()->lifecycle.completeJob(job)).isInstanceOf(MediaRepository.ProcessingLifecycleConflictException.class);
        conflict(()->completion.complete(job,new DiarizationCommands.Complete(cmd.commandId(),owner,"b".repeat(64),stage)));
        conflict(()->completion.complete(job,new DiarizationCommands.Complete(UUID.randomUUID(),owner,cmd.resultSha256(),stage)));
        expire();conflict(()->completion.complete(job,cmd));assertThat(worker.status(job,event).get("state")).isEqualTo("RESULT_VERIFIED");
        sweeper.expireAbandonedStages();assertThat(worker.status(job,event).get("state")).isEqualTo("FAILURE_RECORDED");
        assertThat(count("diarization_worker_verifications")).isEqualTo(1);
    }
    @Test void expiredLeaseCannotRenewReadSnapshotOrRegainToken() {
        claim();worker.renew(job,owner);expire();conflict(()->worker.renew(job,owner));conflict(()->worker.snapshot(job,owner));conflict(()->worker.claim(job,request));
        assertThat(worker.status(job,event).get("state")).isEqualTo("AWAITING_RECONCILIATION");
    }
    @Test void identicalConcurrentClaimsRecoverSameToken() throws Exception {
        try(var pool=Executors.newFixedThreadPool(2)) {
            var gate=new CountDownLatch(1);
            Callable<Object> action=()->{gate.await();return worker.claim(job,request).get("claimToken");};
            var a=pool.submit(action);var b=pool.submit(action);gate.countDown();
            assertThat(a.get(20,TimeUnit.SECONDS)).isEqualTo(b.get(20,TimeUnit.SECONDS));
        }
        assertThat(count("diarization_worker_claims")).isEqualTo(1);
    }
    @Test void explicitRetryPreservesFailureReceiptAndFencesOldOwner() {
        claim();var original=worker.fail(job,new DiarizationCommands.Fail(UUID.randomUUID(),owner,"INFERENCE","TIMEOUT"));
        transactions.executeWithoutResult(tx->{
            transcriptEvidence.lockDiarizationSource(job);
            assertThat(mediaRepository.retryDiarizationAndOutbox(mediaRepository.findJob(job).orElseThrow(),
                transcriptEvidence.diarizationSource(job).orElseThrow(),2)).isTrue();
        });
        assertThat(worker.status(job,event)).isEqualTo(original);
        conflict(()->worker.renew(job,owner));conflict(()->worker.snapshot(job,owner));
        var nextStage=jdbc.queryForObject("SELECT id FROM processing_stage_runs WHERE processing_job_id=? AND stage_code='DIARIZING' AND attempt_number=2",UUID.class,job);
        var nextEvent=jdbc.queryForObject("SELECT event_id FROM processing_diarization_dispatches WHERE stage_run_id=?",UUID.class,nextStage);
        assertThat(worker.status(job,nextEvent).get("state")).isEqualTo("AVAILABLE");
        var next=worker.claim(job,new DiarizationCommands.Claim(nextEvent,request.eventType(),1,meeting,media,nextStage,UUID.randomUUID()));
        assertThat(next.get("claimToken")).isNotEqualTo(owner.claimToken());
        assertThat(count("diarization_worker_receipts")).isEqualTo(1);
    }
    @Test void snapshotRejectsCrossMeetingIdentitySourceMutationAndSegmentOverflow() {
        claim();
        jdbc.update("UPDATE meeting_media SET sha256=? WHERE id=?","b".repeat(64),media);
        conflict(()->worker.snapshot(job,owner));
        jdbc.update("UPDATE meeting_media SET sha256=? WHERE id=?","a".repeat(64),media);
        conflict(()->worker.snapshot(UUID.randomUUID(),owner));
        jdbc.update("INSERT INTO transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,current_text,quality_status,source_stage_run_id) SELECT gen_random_uuid(),?,n,100,200,'PRIVATE','ACCEPTED',source_stage_run_id FROM transcripts CROSS JOIN generate_series(20,16403) n WHERE id=?",transcript,transcript);
        conflict(()->worker.snapshot(job,owner));
    }
    @Test void artifactCorruptionWrongBindingsAndDeclaredLengthAreRejected() throws Exception {
        claim();var n=artifact();n.put("transcriptId",UUID.randomUUID().toString());var wrong=upload(n);
        assertThatThrownBy(()->completion.complete(job,wrong)).isInstanceOfSatisfying(WorkerException.class,e->assertThat(e.code()).isEqualTo("DIARIZATION_RESULT_INVALID"));
        var cmd=upload(artifact());var badDigest=new DiarizationCommands.Complete(UUID.randomUUID(),owner,"b".repeat(64),stage);
        assertThatThrownBy(()->completion.complete(job,badDigest)).isInstanceOfSatisfying(WorkerException.class,e->assertThat(e.code()).isEqualTo("DIARIZATION_RESULT_INVALID"));
        conflict(()->completion.complete(job,new DiarizationCommands.Complete(badDigest.commandId(),owner,cmd.resultSha256(),stage)));
        conflict(()->completion.complete(job,new DiarizationCommands.Complete(cmd.commandId(),owner,cmd.resultSha256(),UUID.randomUUID())));
        when(storage.head(DiarizationWorkerRepository.resultKey(job,stage))).thenReturn(new ObjectStorage.StoredObject(16777217,"application/json",null));
        assertThatThrownBy(()->completion.complete(job,cmd)).isInstanceOfSatisfying(WorkerException.class,e->assertThat(e.code()).isEqualTo("DIARIZATION_RESULT_INVALID"));
        when(storage.head(DiarizationWorkerRepository.resultKey(job,stage))).thenReturn(new ObjectStorage.StoredObject(1,"application/json",null));
        assertThatThrownBy(()->completion.complete(job,cmd)).isInstanceOfSatisfying(WorkerException.class,e->assertThat(e.code()).isEqualTo("DIARIZATION_RESULT_INVALID"));
        assertThat(count("diarization_worker_verifications")).isZero();assertThat(count("diarization_worker_commands")).isEqualTo(3);
    }
    @Test void transcriptEditDuringStorageReadIsFencedBeforeVerification() throws Exception {
        claim();var cmd=upload(artifact());var key=DiarizationWorkerRepository.resultKey(job,stage);var bytes=WorkerJson.MAPPER.writeValueAsBytes(artifact());
        when(storage.readBounded(key,16777216)).thenAnswer(call->{jdbc.update("UPDATE transcripts SET content_revision=1 WHERE id=?",transcript);return bytes;});
        conflict(()->completion.complete(job,cmd));assertThat(count("diarization_worker_verifications")).isZero();
    }
    @Test void sanitizedOptionalFailureReceiptReplaysAfterExpiryAndEditsAndRollsBackAtomically() {
        claim();var cmd=new DiarizationCommands.Fail(UUID.randomUUID(),owner,"INFERENCE","TIMEOUT");
        transactions.executeWithoutResult(tx->{worker.fail(job,cmd);tx.setRollbackOnly();});
        assertThat(stageStatus()).isEqualTo("RUNNING");assertThat(count("diarization_worker_receipts")).isZero();
        var response=worker.fail(job,cmd);expire();jdbc.update("UPDATE transcripts SET content_revision=1 WHERE id=?",transcript);
        assertThat(worker.fail(job,cmd)).isEqualTo(response);assertThat(worker.status(job,event).get("acknowledge")).isEqualTo(true);
        assertThat(stageStatus()).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("SELECT status FROM transcripts WHERE id=?",String.class,transcript)).isEqualTo("READY");
        assertThat(jdbc.queryForObject("SELECT status FROM processing_jobs WHERE id=?",String.class,job)).isEqualTo("COMPLETED_WITH_WARNINGS");
        assertThat(response.toString()).doesNotContain(owner.claimToken().toString(),"PRIVATE","objectKey");
        conflict(()->worker.fail(job,new DiarizationCommands.Fail(cmd.commandId(),owner,"INFERENCE","VALIDATION")));
        assertThat(count("diarization_worker_receipts")).isEqualTo(1);
    }

    @Test void v29UpgradeAndFreshMigrationValidateWithoutChangingHistoricalPlan() {
        var dataSource=jdbc.getDataSource();String schema="spk08_"+UUID.randomUUID().toString().replace("-","");
        try {
            org.flywaydb.core.Flyway.configure().dataSource(dataSource).schemas(schema).defaultSchema(schema)
                .locations("classpath:db/migration").target("29").load().migrate();
            jdbc.update("INSERT INTO "+schema+".users SELECT * FROM public.users WHERE id=?",actor);
            jdbc.update("INSERT INTO "+schema+".meetings SELECT * FROM public.meetings WHERE id=?",meeting);
            jdbc.update("INSERT INTO "+schema+".meeting_media SELECT * FROM public.meeting_media WHERE id=?",media);
            jdbc.update("INSERT INTO "+schema+".processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status) VALUES (?,?,?,?,'PENDING')",job,meeting,media,actor);
            var upgraded=org.flywaydb.core.Flyway.configure().dataSource(dataSource).schemas(schema).defaultSchema(schema)
                .locations("classpath:db/migration").load();
            assertThat(upgraded.migrate().migrationsExecuted).isEqualTo(1);upgraded.validate();
            assertThat(jdbc.queryForObject("SELECT diarization_planned FROM "+schema+".processing_jobs WHERE id=?",Boolean.class,job)).isFalse();
            assertThat(jdbc.queryForObject("SELECT count(*) FROM information_schema.tables WHERE table_schema=? AND table_name LIKE 'diarization_worker_%'",Long.class,schema)).isEqualTo(4);
        } finally {jdbc.execute("DROP SCHEMA IF EXISTS "+schema+" CASCADE");}
    }
}
