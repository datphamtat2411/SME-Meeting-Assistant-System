package com.sme.meetingassistant.api.media.diarization;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.sme.meetingassistant.api.diarization.contract.DiarizationResultContract;
import com.sme.meetingassistant.api.diarization.contract.DiarizationResultContract.ValidatedResult;
import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.util.AopTestUtils;
import org.springframework.transaction.IllegalTransactionStateException;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.node.ObjectNode;

class DiarizationPersistenceIntegrationTests extends DiarizationIntegrationFixture {
    @Autowired TranscriptRepository transcripts;
    @MockitoSpyBean DiarizationSpeakerProjection projection;

    @Override protected TranscriptResult result(UUID producer) {
        return new TranscriptResult(meeting,media,job,producer,"vi",10000L,Status.READY_WITH_WARNINGS,
            List.of(new SegmentResult(7,100,1200,"PRIVATE CORRECTED TEXT","ACCEPTED",null,producer,null),
                new SegmentResult(11,1300,2200,"Second corrected segment.","ACCEPTED",null,producer,null),
                new SegmentResult(19,2300,3000,"Uncertain corrected segment.","SUSPICIOUS",null,producer,null)),
            List.of(new CoverageResult(100,2200,"COVERED",false,0,null),
                new CoverageResult(2300,3000,"SUSPICIOUS",false,1,null)),List.of());
    }

    @Override protected ObjectNode artifact() {
        var n=super.artifact().put("transcriptRevision",revision());
        n.putArray("speakerLabels").add("SPEAKER_01").add("SPEAKER_02");
        var turns=n.putArray("turns");
        turns.addObject().put("startMs",100).put("endMs",1200).put("speakerLabel","SPEAKER_01");
        turns.addObject().put("startMs",900).put("endMs",2200).put("speakerLabel","SPEAKER_02");
        var assignments=n.putArray("assignments");
        assignments.addObject().put("ordinal",7).put("speakerLabel","SPEAKER_01");
        assignments.addObject().put("ordinal",11).put("speakerLabel","SPEAKER_02");
        assignments.addObject().put("ordinal",19).putNull("speakerLabel");
        n.putObject("diagnostics").put("unknownAssignmentCount",1);return n;
    }

    private long revision() {return jdbc.queryForObject("SELECT content_revision FROM transcripts WHERE id=?",Long.class,transcript);}
    private long clusters() {return jdbc.queryForObject("SELECT count(*) FROM speaker_clusters WHERE transcript_id=?",Long.class,transcript);}
    private UUID segment(int ordinal) {return jdbc.queryForObject("SELECT id FROM transcript_segments WHERE transcript_id=? AND ordinal=?",UUID.class,transcript,ordinal);}
    private String jobStatus() {return jdbc.queryForObject("SELECT status FROM processing_jobs WHERE id=?",String.class,job);}
    private List<Map<String,Object>> segments() {return jdbc.queryForList("SELECT * FROM transcript_segments WHERE transcript_id=? ORDER BY ordinal",transcript);}
    private List<Map<String,Object>> immutableSegments() {
        var rows=segments();rows.forEach(row->{row.remove("speaker_cluster_id");row.remove("version");row.remove("updated_at");});return rows;
    }
    private ValidatedResult verifyResult(ObjectNode n,DiarizationCommands.Complete cmd) throws Exception {
        var bytes=WorkerJson.MAPPER.writeValueAsBytes(n);
        var result=DiarizationResultContract.validate(bytes,worker.completionContext(job,cmd),cmd.resultSha256());
        assertThat(worker.registerVerified(job,cmd,bytes.length).get("state")).isEqualTo("RESULT_VERIFIED");return result;
    }
    private void assertUnaccepted() {
        assertThat(clusters()).isZero();assertThat(revision()).isZero();
        assertThat(segments()).allSatisfy(row->{assertThat(row.get("speaker_cluster_id")).isNull();assertThat(row.get("version")).isEqualTo(0L);});
        assertThat(count("diarization_worker_receipts")).isZero();assertThat(stageStatus()).isEqualTo("RUNNING");
        assertThat(jobStatus()).isEqualTo("RUNNING");assertThat(count("diarization_worker_verifications")).isEqualTo(1);
    }
    private static void conflict(Runnable action) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(WorkerException.class,e->{
            assertThat(e.status()).isEqualTo(409);assertThat(e.getMessage()).isEqualTo(e.code());
            assertThat(e.code()).doesNotContain("PRIVATE","SELECT","constraint");
        });
    }

    @Test void twoSpeakersOverlappingTurnsAndUnknownAssignmentsPreserveCorrectedTranscriptAndProvenance() throws Exception {
        var before=immutableSegments();var header=jdbc.queryForMap("SELECT * FROM transcripts WHERE id=?",transcript);header.remove("content_revision");
        var coverage=jdbc.queryForList("SELECT * FROM transcript_coverage_regions WHERE transcript_id=? ORDER BY start_ms",transcript);
        claim();var n=artifact();var cmd=upload(n);var response=completion.complete(job,cmd);
        assertThat(response.get("state")).isEqualTo("RESULT_ACCEPTED");assertThat(response.get("acknowledge")).isEqualTo(true);
        assertThat(transcripts.speakers(meeting)).extracting(s->s.label()).containsExactlyInAnyOrder("SPEAKER_01","SPEAKER_02");
        assertThat(transcripts.speakers(meeting)).allSatisfy(s->assertThat(s.userId()).isNull());
        var view=transcripts.current(meeting).orElseThrow();assertThat(view.contentRevision()).isEqualTo(1);
        assertThat(view.segments()).extracting(s->s.speakerLabel()).containsExactly("SPEAKER_01","SPEAKER_02",null);
        assertThat(view.segments()).extracting(s->s.version()).containsExactly(1L,1L,0L);
        assertThat(immutableSegments()).isEqualTo(before);
        var after=jdbc.queryForMap("SELECT * FROM transcripts WHERE id=?",transcript);after.remove("content_revision");assertThat(after).isEqualTo(header);
        assertThat(jdbc.queryForList("SELECT * FROM transcript_coverage_regions WHERE transcript_id=? ORDER BY start_ms",transcript)).isEqualTo(coverage);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM transcript_segment_revisions r JOIN transcript_segments s ON s.id=r.segment_id WHERE s.transcript_id=?",Long.class,transcript)).isZero();
        assertThat(stageStatus()).isEqualTo("SUCCEEDED");assertThat(jobStatus()).isEqualTo("COMPLETED_WITH_WARNINGS");
        assertThat(jdbc.queryForMap("""
            SELECT v.processing_job_id,v.producer_stage_run_id,v.transcript_id,v.transcript_revision,v.result_sha256,
              v.verification_state,r.outcome FROM diarization_worker_receipts r
            JOIN diarization_worker_verifications v ON v.verification_id=r.verification_id WHERE r.event_id=?
            """,event)).containsEntry("processing_job_id",job).containsEntry("producer_stage_run_id",stage)
            .containsEntry("transcript_id",transcript).containsEntry("transcript_revision",0L).containsEntry("result_sha256",cmd.resultSha256())
            .containsEntry("verification_state","RESULT_VERIFIED").containsEntry("outcome","RESULT_ACCEPTED");
        verify(storage,never()).delete(anyString());
    }

    @ParameterizedTest @ValueSource(ints={0,1})
    void emptyAndSingleSpeakerResultsAreSuccessfulWithoutSyntheticData(int speakers) throws Exception {
        claim();var n=artifact();n.putArray("speakerLabels");n.putArray("turns");
        if(speakers==1) {
            n.withArray("speakerLabels").add("SPEAKER_01");
            n.withArray("turns").addObject().put("startMs",100).put("endMs",2200).put("speakerLabel","SPEAKER_01");
        }
        for(var a:n.withArray("assignments")) {if(speakers==0) ((ObjectNode)a).putNull("speakerLabel");else ((ObjectNode)a).put("speakerLabel","SPEAKER_01");}
        n.putObject("diagnostics").put("unknownAssignmentCount",speakers==0?3:0);
        var before=segments();var cmd=upload(n);assertThat(completion.complete(job,cmd).get("state")).isEqualTo("RESULT_ACCEPTED");
        assertThat(clusters()).isEqualTo(speakers);assertThat(revision()).isEqualTo(speakers);
        if(speakers==0) assertThat(segments()).isEqualTo(before);
        assertThat(stageStatus()).isEqualTo("SUCCEEDED");assertThat(jobStatus()).isEqualTo("COMPLETED_WITH_WARNINGS");
    }

    @Test void detectedSpeakersWithOnlyUnknownAssignmentsStillAdvanceContentRevisionOnce() throws Exception {
        claim();var n=artifact();for(var a:n.withArray("assignments")) ((ObjectNode)a).putNull("speakerLabel");
        n.putObject("diagnostics").put("unknownAssignmentCount",3);var before=segments();
        var cmd=upload(n);completion.complete(job,cmd);assertThat(clusters()).isEqualTo(2);assertThat(revision()).isEqualTo(1);
        assertThat(segments()).isEqualTo(before);
    }

    @Test void exactReplayPreservesReceiptClusterIdsVersionsAndHumanEditsAfterLeaseExpiry() throws Exception {
        claim();var cmd=upload(artifact());var accepted=completion.complete(job,cmd);
        UUID cluster=transcripts.current(meeting).orElseThrow().segments().getFirst().speakerClusterId();
        transactions.executeWithoutResult(tx->{
            transcripts.correct(meeting,segment(7),actor,"Human text after acceptance.","Review",1);
            transcripts.mapSpeaker(meeting,cluster,actor,actor,transcript,2);
        });
        var before=segments();var speakers=transcripts.speakers(meeting);expire();
        jdbc.update("UPDATE transcripts SET is_current=FALSE WHERE id=?",transcript);
        clearInvocations(storage,projection);
        assertThat(completion.complete(job,cmd)).isEqualTo(accepted);verifyNoInteractions(storage,projection);
        assertThat(segments()).isEqualTo(before);assertThat(transcripts.speakers(meeting)).isEmpty();
        assertThat(jdbc.queryForList("SELECT id FROM speaker_clusters WHERE transcript_id=?",UUID.class,transcript)).containsExactlyInAnyOrderElementsOf(speakers.stream().map(s->s.id()).toList());
        assertThat(revision()).isEqualTo(3);assertThat(count("diarization_worker_receipts")).isEqualTo(1);
        assertThat(count("processing_stage_runs")).isEqualTo(4);
        conflict(()->completion.complete(job,new DiarizationCommands.Complete(UUID.randomUUID(),owner,cmd.resultSha256(),stage)));
        conflict(()->completion.complete(job,new DiarizationCommands.Complete(cmd.commandId(),owner,"b".repeat(64),stage)));
    }

    @ParameterizedTest @ValueSource(strings={"missing","additional","changed"})
    void canonicalOrdinalMutationAfterVerificationRejectsWholeProjection(String mutation) throws Exception {
        claim();var n=artifact();var cmd=upload(n);var result=verifyResult(n,cmd);
        if(mutation.equals("missing")) jdbc.update("DELETE FROM transcript_segments WHERE id=?",segment(11));
        else if(mutation.equals("changed")) jdbc.update("UPDATE transcript_segments SET ordinal=12 WHERE id=?",segment(11));
        else jdbc.update("INSERT INTO transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,current_text,quality_status) VALUES (?,?,23,3500,4000,'Extra','ACCEPTED')",UUID.randomUUID(),transcript);
        conflict(()->worker.projectVerified(job,cmd,result));assertUnaccepted();
    }

    @ParameterizedTest @ValueSource(strings={"missing","duplicate","additional","foreignLabel"})
    void malformedAssignmentSetsNeverBecomeVerified(String mutation) throws Exception {
        claim();var n=artifact();var assignments=n.withArray("assignments");
        switch(mutation) {
            case "missing" -> assignments.remove(1);
            case "duplicate" -> ((ObjectNode)assignments.get(1)).put("ordinal",7);
            case "additional" -> assignments.addObject().put("ordinal",23).putNull("speakerLabel");
            default -> ((ObjectNode)assignments.get(1)).put("speakerLabel","SPEAKER_99");
        }
        var cmd=upload(n);assertThatThrownBy(()->completion.complete(job,cmd)).isInstanceOfSatisfying(WorkerException.class,e->assertThat(e.code()).isEqualTo("DIARIZATION_RESULT_INVALID"));
        assertThat(clusters()).isZero();assertThat(count("diarization_worker_verifications")).isZero();
    }

    @ParameterizedTest @ValueSource(strings={"revision","notCurrent","source","expired","superseded","token","producer"})
    void verifiedResultCannotBypassStaleSourceAndAttemptFences(String mutation) throws Exception {
        claim();var n=artifact();var cmd=upload(n);var result=verifyResult(n,cmd);
        switch(mutation) {
            case "revision" -> jdbc.update("UPDATE transcripts SET content_revision=1 WHERE id=?",transcript);
            case "notCurrent" -> jdbc.update("UPDATE transcripts SET is_current=FALSE WHERE id=?",transcript);
            case "source" -> jdbc.update("UPDATE meeting_media SET sha256=? WHERE id=?","b".repeat(64),media);
            case "expired" -> expire();
            case "superseded" -> jdbc.update("INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status) VALUES (?,?,'DIARIZING',2,'PENDING')",UUID.randomUUID(),job);
            case "token" -> cmd=new DiarizationCommands.Complete(cmd.commandId(),new DiarizationCommands.Owner(event,stage,UUID.randomUUID()),cmd.resultSha256(),stage);
            case "producer" -> cmd=new DiarizationCommands.Complete(cmd.commandId(),owner,cmd.resultSha256(),UUID.randomUUID());
        }
        var command=cmd;conflict(()->worker.projectVerified(job,command,result));
        assertThat(clusters()).isZero();assertThat(count("diarization_worker_receipts")).isZero();assertThat(stageStatus()).isEqualTo("RUNNING");
        assertThat(count("diarization_worker_verifications")).isEqualTo(1);
    }

    @ParameterizedTest @ValueSource(strings={"transcriptId","processingJobId","sourceMediaId","sourceRevision"})
    void wrongArtifactBindingsAreRejected(String field) throws Exception {
        claim();var n=artifact().put(field,field.equals("sourceRevision")?"b".repeat(64):UUID.randomUUID().toString());var cmd=upload(n);
        assertThatThrownBy(()->completion.complete(job,cmd)).isInstanceOfSatisfying(WorkerException.class,e->assertThat(e.code()).isEqualTo("DIARIZATION_RESULT_INVALID"));
        assertThat(clusters()).isZero();assertThat(count("diarization_worker_verifications")).isZero();
    }

    @ParameterizedTest @ValueSource(strings={"unassignedCluster","association","activeMapping","mappingHistory"})
    void existingSpeakerStateAndHumanMappingHistoryAreNeverOverwritten(String state) throws Exception {
        claim();
        UUID cluster=UUID.randomUUID();jdbc.update("INSERT INTO speaker_clusters(id,transcript_id,label) VALUES (?,?,'SPEAKER_01')",cluster,transcript);
        if(state.equals("association")) jdbc.update("UPDATE transcript_segments SET speaker_cluster_id=? WHERE id=?",cluster,segment(7));
        if(state.equals("activeMapping")) transactions.executeWithoutResult(tx->transcripts.mapSpeaker(meeting,cluster,actor,actor,transcript,0));
        if(state.equals("mappingHistory")) jdbc.update("INSERT INTO speaker_mappings(id,speaker_cluster_id,user_id,mapped_by_user_id,superseded_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)",UUID.randomUUID(),cluster,actor,actor);
        var before=segments();var mappings=jdbc.queryForList("SELECT * FROM speaker_mappings WHERE speaker_cluster_id=?",cluster);
        var cmd=upload(artifact());conflict(()->completion.complete(job,cmd));
        assertThat(clusters()).isEqualTo(1);assertThat(segments()).isEqualTo(before);
        assertThat(jdbc.queryForList("SELECT * FROM speaker_mappings WHERE speaker_cluster_id=?",cluster)).isEqualTo(mappings);
        assertThat(count("diarization_worker_receipts")).isZero();assertThat(stageStatus()).isEqualTo("RUNNING");
    }

    @Test void retryPinnedAfterHumanCorrectionPreservesTextAndItsRevisionHistory() throws Exception {
        claim();worker.fail(job,new DiarizationCommands.Fail(UUID.randomUUID(),owner,"INFERENCE","TIMEOUT"));
        transactions.executeWithoutResult(tx->transcripts.correct(meeting,segment(7),actor,"Authorized human correction.","Review",0));
        transactions.executeWithoutResult(tx->{
            transcriptEvidence.lockDiarizationSource(job);
            assertThat(mediaRepository.retryDiarizationAndOutbox(mediaRepository.findJob(job).orElseThrow(),transcriptEvidence.diarizationSource(job).orElseThrow(),2)).isTrue();
        });
        stage=jdbc.queryForObject("SELECT id FROM processing_stage_runs WHERE processing_job_id=? AND stage_code='DIARIZING' AND attempt_number=2",UUID.class,job);
        event=jdbc.queryForObject("SELECT event_id FROM processing_diarization_dispatches WHERE stage_run_id=?",UUID.class,stage);
        request=new DiarizationCommands.Claim(event,"PROCESSING_DIARIZATION_REQUESTED",1,meeting,media,stage,UUID.randomUUID());
        var before=immutableSegments();var history=jdbc.queryForList("SELECT * FROM transcript_segment_revisions WHERE segment_id=?",segment(7));
        claim();completion.complete(job,upload(artifact()));assertThat(revision()).isEqualTo(2);assertThat(immutableSegments()).isEqualTo(before);
        assertThat(jdbc.queryForList("SELECT * FROM transcript_segment_revisions WHERE segment_id=?",segment(7))).isEqualTo(history);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM processing_stage_runs WHERE processing_job_id=? AND stage_code IN ('TRANSCRIPTION','CONTEXTUAL_CORRECTION')",Long.class,job)).isEqualTo(2);
    }

    @Test void projectionExceptionAfterRealWritesRollsBackCanonicalContentAndAcceptance() throws Exception {
        claim();var cmd=upload(artifact());var before=segments();
        DiarizationSpeakerProjection target=AopTestUtils.getUltimateTargetObject(projection);
        doAnswer(call->{call.callRealMethod();assertThat(clusters()).isEqualTo(2);assertThat(revision()).isEqualTo(1);throw WorkerException.conflict("DIARIZATION_PROJECTION_CONFLICT");}).when(target).project(any());
        conflict(()->completion.complete(job,cmd));assertUnaccepted();assertThat(segments()).isEqualTo(before);
        assertThat(worker.status(job,event).get("state")).isEqualTo("RESULT_VERIFIED");
    }

    @Test void rollbackAfterReceiptStageAndJobWritesRevertsEveryAcceptanceMutation() throws Exception {
        claim();var n=artifact();var cmd=upload(n);var result=verifyResult(n,cmd);var before=segments();
        conflict(()->transactions.executeWithoutResult(tx->{
            assertThat(worker.projectVerified(job,cmd,result).get("state")).isEqualTo("RESULT_ACCEPTED");
            assertThat(stageStatus()).isEqualTo("SUCCEEDED");assertThat(jobStatus()).isEqualTo("COMPLETED_WITH_WARNINGS");
            throw WorkerException.conflict("DIARIZATION_PROJECTION_CONFLICT");
        }));
        assertUnaccepted();assertThat(segments()).isEqualTo(before);
    }

    @Test void projectionRequiresTransactionAndCannotCommitWithoutAcceptance() throws Exception {
        claim();var n=artifact();var cmd=upload(n);var result=verifyResult(n,cmd);
        assertThatThrownBy(()->projection.project(result)).isInstanceOf(IllegalTransactionStateException.class);
        assertThatThrownBy(()->transactions.executeWithoutResult(tx->projection.project(result))).isInstanceOf(WorkerException.class);
        assertUnaccepted();
    }

    @Test void concurrentCompletionsReturnOneReceiptAndOneProjection() throws Exception {
        claim();var cmd=upload(artifact());var gate=new CountDownLatch(1);
        try(var pool=Executors.newFixedThreadPool(2)) {
            Callable<Map<String,Object>> accept=()->{await(gate);return completion.complete(job,cmd);};
            var first=pool.submit(accept);var second=pool.submit(accept);gate.countDown();
            assertThat(first.get(20,TimeUnit.SECONDS)).isEqualTo(second.get(20,TimeUnit.SECONDS));
        }
        assertThat(clusters()).isEqualTo(2);assertThat(revision()).isEqualTo(1);assertThat(count("diarization_worker_receipts")).isEqualTo(1);
        verify(projection,times(1)).project(any());
    }

    @Test void humanCorrectionHoldingMeetingLockWinsAndFencesWaitingAcceptance() throws Exception {
        claim();var n=artifact();var cmd=upload(n);var result=verifyResult(n,cmd);
        var locked=new CountDownLatch(1);var release=new CountDownLatch(1);var started=new CountDownLatch(1);
        try(var pool=Executors.newFixedThreadPool(2)) {
            var edit=pool.submit(()->transactions.executeWithoutResult(tx->{
                transcripts.correct(meeting,segment(7),actor,"Concurrent human correction.","Review",0);locked.countDown();await(release);
            }));
            await(locked);
            var acceptance=pool.submit(()->{started.countDown();conflict(()->worker.projectVerified(job,cmd,result));});
            try {await(started);assertThatThrownBy(()->acceptance.get(200,TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);}
            finally {release.countDown();}
            edit.get(20,TimeUnit.SECONDS);acceptance.get(20,TimeUnit.SECONDS);
        }
        assertThat(revision()).isEqualTo(1);assertThat(clusters()).isZero();assertThat(count("diarization_worker_receipts")).isZero();
        assertThat(transcripts.current(meeting).orElseThrow().segments().getFirst().text()).isEqualTo("Concurrent human correction.");
    }

    @ParameterizedTest @ValueSource(strings={"text","mapping"})
    void acceptanceHoldingMeetingLockFencesStaleHumanReview(String review) throws Exception {
        claim();var n=artifact();var cmd=upload(n);var result=verifyResult(n,cmd);
        var locked=new CountDownLatch(1);var release=new CountDownLatch(1);var started=new CountDownLatch(1);var cluster=new AtomicReference<UUID>();
        try(var pool=Executors.newFixedThreadPool(2)) {
            var acceptance=pool.submit(()->transactions.executeWithoutResult(tx->{
                worker.projectVerified(job,cmd,result);cluster.set(transcripts.current(meeting).orElseThrow().segments().getFirst().speakerClusterId());
                locked.countDown();await(release);
            }));
            await(locked);
            var edit=pool.submit(()->{started.countDown();assertThatThrownBy(()->transactions.executeWithoutResult(tx->{
                if(review.equals("text")) transcripts.correct(meeting,segment(7),actor,"Stale review","Review",0);
                else transcripts.mapSpeaker(meeting,cluster.get(),actor,actor,transcript,0);
            })).isInstanceOfSatisfying(ResponseStatusException.class,e->assertThat(e.getStatusCode().value()).isEqualTo(412));});
            try {await(started);assertThatThrownBy(()->edit.get(200,TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);}
            finally {release.countDown();}
            acceptance.get(20,TimeUnit.SECONDS);edit.get(20,TimeUnit.SECONDS);
        }
        assertThat(revision()).isEqualTo(1);assertThat(clusters()).isEqualTo(2);
    }

    @Test void downstreamStageContinuesAndRequiredWorkStillControlsJobCompletion() throws Exception {
        jdbc.update("INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status) VALUES (?,?,'INDEXING',1,'PENDING')",UUID.randomUUID(),job);
        claim();assertThatThrownBy(()->lifecycle.startStage(job,"INDEXING",null,null)).isInstanceOf(MediaRepository.ProcessingLifecycleConflictException.class);
        completion.complete(job,upload(artifact()));assertThat(jobStatus()).isEqualTo("RUNNING");
        var indexing=lifecycle.startStage(job,"INDEXING",null,null);lifecycle.completeStage(indexing,"SUCCEEDED",null,null);lifecycle.completeJob(job);
        assertThat(jobStatus()).isEqualTo("COMPLETED_WITH_WARNINGS");assertThat(stageStatus()).isEqualTo("SUCCEEDED");
    }

    @Test void databaseEnforcesLocalClusterAssignmentsUniqueLabelsAndUniqueOrdinals() {
        UUID other=UUID.randomUUID(),cluster=UUID.randomUUID(),otherJob=UUID.randomUUID();
        jdbc.update("INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status,reprocess_of_job_id) VALUES (?,?,?,?,'COMPLETED',?)",otherJob,meeting,media,actor,job);
        jdbc.update("INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,version_number,language_code,status) VALUES (?,?,?,?,2,'vi','PROCESSING')",other,meeting,media,otherJob);
        jdbc.update("INSERT INTO speaker_clusters(id,transcript_id,label) VALUES (?,?,'SPEAKER_01')",cluster,other);
        assertThatThrownBy(()->jdbc.update("UPDATE transcript_segments SET speaker_cluster_id=? WHERE id=?",cluster,segment(7))).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(()->jdbc.update("UPDATE transcript_segments SET speaker_cluster_id=? WHERE id=?",UUID.randomUUID(),segment(7))).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(()->jdbc.update("INSERT INTO speaker_clusters(id,transcript_id,label) VALUES (?,?,'SPEAKER_01')",UUID.randomUUID(),other)).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(()->jdbc.update("UPDATE transcript_segments SET ordinal=7 WHERE id=?",segment(11))).isInstanceOf(DataIntegrityViolationException.class);
    }

    private static void await(CountDownLatch latch) {
        try {if(!latch.await(15,TimeUnit.SECONDS)) throw new IllegalStateException("Concurrency gate timed out.");}
        catch(InterruptedException interrupted) {Thread.currentThread().interrupt();throw new IllegalStateException(interrupted);}
    }
}
