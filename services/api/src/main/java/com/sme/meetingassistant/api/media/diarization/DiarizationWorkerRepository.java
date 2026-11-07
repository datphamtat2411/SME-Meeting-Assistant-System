package com.sme.meetingassistant.api.media.diarization;

import static com.sme.meetingassistant.api.media.worker.WorkerJson.MAPPER;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import java.time.OffsetDateTime;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.JsonNode;

@Repository
public class DiarizationWorkerRepository {
    private final JdbcTemplate jdbc;
    public DiarizationWorkerRepository(JdbcTemplate jdbc) { this.jdbc=jdbc; }
    public record Delivery(UUID job,UUID event,UUID stage,UUID meeting,UUID media,String sourceRevision,
        UUID transcript,long revision,int attempt,int latest,String stageStatus,String jobStatus,JsonNode notification) {}
    public record Claim(UUID stage,UUID token,UUID request,String fingerprint,JsonNode source,
        OffsetDateTime expires,boolean live) {
        @Override public String toString() { return "DiarizationClaim[redacted]"; }
    }
    public record Command(UUID id,String fingerprint,String type) {}
    public record Verification(UUID id,UUID command,String digest,int size,OffsetDateTime verifiedAt) {}
    public record Receipt(UUID id,UUID command,String state,UUID verification,String error,Boolean retryable,
        OffsetDateTime recordedAt) {}

    public Delivery delivery(UUID job,UUID event) {
        return jdbc.query("""
            SELECT d.*,e.payload AS notification_payload,s.attempt_number,s.status AS stage_status,j.status AS job_status,
              (SELECT MAX(x.attempt_number) FROM processing_stage_runs x
                WHERE x.processing_job_id=j.id AND x.stage_code='DIARIZING') AS latest
            FROM processing_diarization_dispatches d
            JOIN processing_jobs j ON j.id=d.processing_job_id AND j.meeting_id=d.meeting_id
              AND j.source_media_id=d.source_media_id AND j.diarization_planned
            JOIN processing_stage_runs s ON s.id=d.stage_run_id AND s.processing_job_id=j.id AND s.stage_code='DIARIZING'
            JOIN outbox_events e ON e.id=d.event_id AND e.aggregate_id=j.id AND e.aggregate_type='PROCESSING_JOB'
              AND e.event_type='PROCESSING_DIARIZATION_REQUESTED'
              AND e.payload->>'eventId'=d.event_id::text AND e.payload->>'processingJobId'=j.id::text
              AND e.payload->>'meetingId'=d.meeting_id::text AND e.payload->>'sourceMediaId'=d.source_media_id::text
              AND e.payload->>'stageRunId'=d.stage_run_id::text AND e.payload->>'sourceRevision'=d.source_revision
              AND e.payload->>'transcriptId'=d.transcript_id::text AND e.payload->>'transcriptRevision'=d.transcript_revision::text
            WHERE d.processing_job_id=? AND d.event_id=?
            """,(r,n)->new Delivery(job,event,r.getObject("stage_run_id",UUID.class),r.getObject("meeting_id",UUID.class),
                r.getObject("source_media_id",UUID.class),r.getString("source_revision"),r.getObject("transcript_id",UUID.class),
                r.getLong("transcript_revision"),r.getInt("attempt_number"),r.getInt("latest"),r.getString("stage_status"),r.getString("job_status"),
                MAPPER.readTree(r.getString("notification_payload"))),job,event)
            .stream().findFirst().orElseThrow(()->new WorkerException(404,"WORKER_DELIVERY_NOT_FOUND"));
    }
    public void lockJob(UUID job) { jdbc.queryForObject("SELECT id FROM processing_jobs WHERE id=? FOR UPDATE",UUID.class,job); }
    public Optional<Claim> claim(UUID event) {
        return jdbc.query("""
            SELECT c.*,s.lease_expires_at,(s.status='RUNNING' AND s.claim_token=c.claim_token
              AND s.lease_expires_at>clock_timestamp() AND j.status='RUNNING' AND j.current_stage='DIARIZING'
              AND s.attempt_number=(SELECT MAX(x.attempt_number) FROM processing_stage_runs x
                WHERE x.processing_job_id=j.id AND x.stage_code='DIARIZING')) AS live
            FROM diarization_worker_claims c JOIN processing_stage_runs s ON s.id=c.execution_stage_run_id
            JOIN processing_jobs j ON j.id=c.processing_job_id
            WHERE c.event_id=? AND c.principal='urn:sme:service:ai-worker'
            """,(r,n)->new Claim(r.getObject("execution_stage_run_id",UUID.class),r.getObject("claim_token",UUID.class),
                r.getObject("claim_request_id",UUID.class),r.getString("request_sha256"),MAPPER.readTree(r.getString("source_descriptor")),
                r.getObject("lease_expires_at",OffsetDateTime.class),r.getBoolean("live")),event).stream().findFirst();
    }
    public JsonNode source(Delivery d,String storageId) {
        return jdbc.<JsonNode>query("""
            SELECT m.* FROM meeting_media m JOIN processing_jobs j ON j.source_media_id=m.id AND j.meeting_id=m.meeting_id
            WHERE j.id=? AND m.id=? AND m.meeting_id=? AND m.status='AVAILABLE' AND m.sha256=?
              AND m.available_at IS NOT NULL AND m.size_bytes>0 AND m.duration_ms>0
              AND m.object_key=('meetings/' || m.meeting_id || '/sources/' || m.id) FOR SHARE OF m
            """,(r,n)->MAPPER.valueToTree(Map.of("sourceMediaId",d.media(),"sourceRevision",r.getString("sha256"),
                "storageId",storageId,"objectKey",r.getString("object_key"),"contentType",r.getString("content_type"),
                "sizeBytes",r.getLong("size_bytes"),"sha256",r.getString("sha256"),"durationMs",r.getLong("duration_ms"))),d.job(),d.media(),d.meeting(),d.sourceRevision())
            .stream().findFirst().orElseThrow(()->WorkerException.conflict("DIARIZATION_SOURCE_STALE"));
    }
    public void insertClaim(Delivery d,DiarizationCommands.Claim cmd,UUID token,JsonNode source) {
        jdbc.update("""
            INSERT INTO diarization_worker_claims(event_id,processing_job_id,execution_stage_run_id,principal,
                claim_request_id,request_sha256,claim_token,source_descriptor)
            VALUES (?,?,?,'urn:sme:service:ai-worker',?,?,?,CAST(? AS jsonb))
            """,d.event(),d.job(),d.stage(),cmd.claimRequestId(),DiarizationCommands.fingerprint(cmd),token,source.toString());
    }
    public Optional<Command> command(UUID id) {
        return jdbc.query("SELECT * FROM diarization_worker_commands WHERE command_id=?",
            (r,n)->new Command(id,r.getString("request_sha256"),r.getString("command_type")),id).stream().findFirst();
    }
    public void insertCommand(Delivery d,UUID id,String fingerprint,String type) {
        jdbc.update("""
            INSERT INTO diarization_worker_commands(command_id,processing_job_id,event_id,execution_stage_run_id,command_type,request_sha256)
            VALUES (?,?,?,?,?,?)
            """,id,d.job(),d.event(),d.stage(),type,fingerprint);
    }
    public Optional<Verification> verification(UUID event) {
        return jdbc.query("SELECT * FROM diarization_worker_verifications WHERE event_id=?",
            (r,n)->new Verification(r.getObject("verification_id",UUID.class),r.getObject("command_id",UUID.class),
                r.getString("result_sha256"),r.getInt("size_bytes"),r.getObject("verified_at",OffsetDateTime.class)),event).stream().findFirst();
    }
    public void verify(Delivery d,Claim c,DiarizationCommands.Complete cmd,int size) {
        jdbc.update("""
            INSERT INTO diarization_worker_verifications(verification_id,processing_job_id,event_id,execution_stage_run_id,
                producer_stage_run_id,command_id,source_revision,transcript_id,transcript_revision,result_sha256,storage_id,object_key,size_bytes)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,UUID.randomUUID(),d.job(),d.event(),d.stage(),d.stage(),cmd.commandId(),d.sourceRevision(),d.transcript(),d.revision(),
                cmd.resultSha256(),c.source().get("storageId").asString(),resultKey(d.job(),d.stage()),size);
    }
    public Optional<Receipt> receipt(UUID event) {
        return jdbc.query("SELECT * FROM diarization_worker_receipts WHERE event_id=?",
            (r,n)->new Receipt(r.getObject("receipt_id",UUID.class),r.getObject("command_id",UUID.class),r.getString("outcome"),
                r.getObject("verification_id",UUID.class),r.getString("error_code"),(Boolean)r.getObject("retryable"),
                r.getObject("recorded_at",OffsetDateTime.class)),event).stream().findFirst();
    }
    public void failure(Delivery d,DiarizationCommands.Fail cmd,boolean retryable) {
        insertCommand(d,cmd.commandId(),DiarizationCommands.fingerprint(cmd),"FAIL");
        jdbc.update("""
            INSERT INTO diarization_worker_receipts(receipt_id,processing_job_id,event_id,execution_stage_run_id,command_id,outcome,error_code,retryable)
            VALUES (?,?,?,?,?,'FAILURE_RECORDED','DIARIZATION_FAILED',?)
            """,UUID.randomUUID(),d.job(),d.event(),d.stage(),cmd.commandId(),retryable);
    }
    public UUID accept(Delivery d,DiarizationCommands.Complete cmd,Verification v) {
        UUID receipt=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO diarization_worker_receipts(receipt_id,processing_job_id,event_id,execution_stage_run_id,command_id,outcome,verification_id)
            VALUES (?,?,?,?,?,'RESULT_ACCEPTED',?)
            """,receipt,d.job(),d.event(),d.stage(),cmd.commandId(),v.id());
        return receipt;
    }
    public void measureAcceptance(Delivery d,UUID receipt,int speakers,int unknown,int segments) {
        jdbc.update("""
            INSERT INTO diarization_acceptance_measurements(execution_stage_run_id,processing_job_id,event_id,receipt_id,
                speaker_count,unknown_assignment_count,segment_count) VALUES (?,?,?,?,?,?,?)
            """,d.stage(),d.job(),d.event(),receipt,speakers,unknown,segments);
    }
    public OffsetDateTime now() { return jdbc.queryForObject("SELECT clock_timestamp()",OffsetDateTime.class); }
    public static String resultKey(UUID job,UUID stage) {return "processing/"+job+"/diarization/results/"+stage+".json";}
}
