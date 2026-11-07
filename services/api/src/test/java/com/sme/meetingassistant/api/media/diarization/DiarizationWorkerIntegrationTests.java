package com.sme.meetingassistant.api.media.diarization;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import com.sme.meetingassistant.api.diarization.contract.DiarizationResultContract;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.node.ObjectNode;

class DiarizationWorkerIntegrationTests extends DiarizationIntegrationFixture {
    private void conflict(Runnable action) { assertThatThrownBy(action::run).isInstanceOf(WorkerException.class); }

    @Test void claimVersionMatchesTheImmutablePersistedNotification() {
        var notification=WorkerJson.MAPPER.readTree(jdbc.queryForObject("SELECT payload::text FROM outbox_events WHERE id=?",String.class,event));
        assertThat(notification.path("schemaVersion").isIntegralNumber()).isTrue();
        assertThat(notification.path("schemaVersion").intValue()).isEqualTo(1);
        conflict(()->worker.claim(job,new DiarizationCommands.Claim(event,request.eventType(),2,meeting,media,stage,UUID.randomUUID())));
        assertThat(count("diarization_worker_claims")).isZero();
        var data=claim();
        assertThat(data.get("eventSchemaVersion")).isEqualTo(notification.path("schemaVersion").intValue());
        assertThat(data.get("executionStageRunId")).isEqualTo(stage);
    }

    @ParameterizedTest
    @ValueSource(strings={"missing","null","\"1\"","true","false","1.0","1.5","0","-1","2","[]","{}","999999999999999999999"})
    void hardCodedClaimVersionCannotAuthorizeInvalidPersistedNotification(String version) {
        insertHistoricalNotification(version,"PROCESSING_DIARIZATION_REQUESTED");
        String original=jdbc.queryForObject("SELECT payload::text FROM outbox_events WHERE id=?",String.class,event);
        assertThat(worker.status(job,event).get("state")).isEqualTo("AVAILABLE");
        assertThatThrownBy(()->worker.claim(job,request)).isInstanceOfSatisfying(WorkerException.class,e->{
            assertThat(e.status()).isEqualTo(422);
            assertThat(e.code()).isEqualTo("VALIDATION_ERROR");
            assertThat(e.getMessage()).isEqualTo("VALIDATION_ERROR");
        });
        assertThat(count("diarization_worker_claims")).isZero();
        assertThat(stageStatus()).isEqualTo("PENDING");
        assertThat(jdbc.queryForObject("SELECT status FROM transcripts WHERE id=?",String.class,transcript)).isEqualTo("READY");
        assertThat(jdbc.queryForObject("SELECT payload::text FROM outbox_events WHERE id=?",String.class,event)).isEqualTo(original);
    }

    @Test void matchingVersionCannotAuthorizeWrongPersistedEventType() {
        insertHistoricalNotification("1","PROCESSING_JOB_QUEUED");
        assertThatThrownBy(()->worker.claim(job,request)).isInstanceOfSatisfying(WorkerException.class,
            e->assertThat(e.code()).isEqualTo("WORKER_DELIVERY_NOT_FOUND"));
        assertThat(count("diarization_worker_claims")).isZero();
        assertThat(stageStatus()).isEqualTo("PENDING");
    }

    private void insertHistoricalNotification(String version,String eventType) {
        UUID originalEvent=event;
        var payload=(ObjectNode)WorkerJson.MAPPER.readTree(jdbc.queryForObject("SELECT payload::text FROM outbox_events WHERE id=?",String.class,event));
        event=UUID.randomUUID();stage=UUID.randomUUID();
        payload.put("eventId",event.toString()).put("stageRunId",stage.toString());
        if("missing".equals(version)) payload.remove("schemaVersion");
        else payload.set("schemaVersion",WorkerJson.MAPPER.readTree(version));
        // Insert legacy evidence directly; never rewrite a committed immutable event
        // or disable the database's dispatch/notification guards for compatibility tests.
        jdbc.update("INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status) VALUES (?,?,'DIARIZING',2,'PENDING')",stage,job);
        jdbc.update("""
            INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,occurred_at)
            SELECT ?,aggregate_type,aggregate_id,?,CAST(? AS jsonb),occurred_at FROM outbox_events WHERE id=?
            """,event,eventType,payload.toString(),originalEvent);
        jdbc.update("""
            INSERT INTO processing_diarization_dispatches(stage_run_id,processing_job_id,meeting_id,
              source_media_id,source_revision,transcript_id,transcript_revision,event_id,created_at)
            SELECT ?,processing_job_id,meeting_id,source_media_id,source_revision,transcript_id,transcript_revision,?,created_at
            FROM processing_diarization_dispatches WHERE event_id=?
            """,stage,event,originalEvent);
        request=new DiarizationCommands.Claim(event,"PROCESSING_DIARIZATION_REQUESTED",1,meeting,media,stage,UUID.randomUUID());
    }

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
        claim();var n=artifact();var cmd=upload(n);
        var bytes=WorkerJson.MAPPER.writeValueAsBytes(n);
        DiarizationResultContract.validate(bytes,worker.completionContext(job,cmd),cmd.resultSha256());
        var response=worker.registerVerified(job,cmd,bytes.length);
        assertThat(response.get("state")).isEqualTo("RESULT_VERIFIED");assertThat(response.get("acknowledge")).isEqualTo(false);
        assertThat(worker.registerVerified(job,cmd,bytes.length)).isEqualTo(response);
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
            assertThat(upgraded.migrate().migrationsExecuted).isEqualTo(4);upgraded.validate();
            assertThat(jdbc.queryForObject("SELECT diarization_planned FROM "+schema+".processing_jobs WHERE id=?",Boolean.class,job)).isFalse();
            assertThat(jdbc.queryForObject("SELECT count(*) FROM information_schema.tables WHERE table_schema=? AND table_name LIKE 'diarization_worker_%'",Long.class,schema)).isEqualTo(4);
        } finally {jdbc.execute("DROP SCHEMA IF EXISTS "+schema+" CASCADE");}
    }
}
