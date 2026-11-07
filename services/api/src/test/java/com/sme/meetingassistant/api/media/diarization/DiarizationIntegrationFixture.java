package com.sme.meetingassistant.api.media.diarization;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

import com.sme.meetingassistant.api.integration.TranscriptFinalizationService;
import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.repository.MediaRepository;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycleService;
import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.transcript.service.TranscriptCorrectionDigest;
import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.*;
import java.util.*;
import org.junit.jupiter.api.BeforeEach;
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
abstract class DiarizationIntegrationFixture {
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
    protected TranscriptResult result(UUID producer) {
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
}
