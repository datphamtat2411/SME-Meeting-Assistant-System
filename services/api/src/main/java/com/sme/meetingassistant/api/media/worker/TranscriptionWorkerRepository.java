package com.sme.meetingassistant.api.media.worker;

import static com.sme.meetingassistant.api.media.worker.WorkerJson.*;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.JsonNode;

/** Media-owned evidence repository. Business status is always read from existing jobs/stages. */
@Repository
public class TranscriptionWorkerRepository {
    private final JdbcTemplate jdbc;
    public TranscriptionWorkerRepository(JdbcTemplate jdbc) { this.jdbc=jdbc; }
    public record Delivery(UUID jobId,UUID eventId,int generation,String eventType,int schemaVersion,
        UUID meetingId,UUID mediaId,UUID requester,String retryFromStage,int currentGeneration,String jobStatus) {}
    public record Claim(UUID eventId,UUID stageId,UUID token,String stageCode,UUID requestId,String requestDigest,
        JsonNode source,UUID reusableProducer,String stageStatus,OffsetDateTime leaseExpiresAt,boolean live) {
        @Override public String toString() { return "WorkerClaim[redacted]"; }
    }
    public record Receipt(UUID id,UUID eventId,String state,UUID commandId,String commandDigest,UUID stageId,
        UUID producerId,String resultDigest,String correctionDigest,UUID transcriptId,String transcriptStatus,
        String errorCode,Boolean retryable,Boolean exhausted,OffsetDateTime recordedAt) {}
    public Delivery delivery(UUID job,UUID event) {
        return jdbc.query("""
            SELECT d.*,j.retry_count,j.status AS job_status FROM transcription_worker_deliveries d
            JOIN processing_jobs j ON j.id=d.processing_job_id WHERE d.processing_job_id=? AND d.event_id=?
            """,(r,n)->new Delivery(job,event,r.getInt("generation"),r.getString("event_type"),
                r.getInt("event_schema_version"),r.getObject("meeting_id",UUID.class),r.getObject("source_media_id",UUID.class),
                r.getObject("requested_by_user_id",UUID.class),r.getString("retry_from_stage"),r.getInt("retry_count"),r.getString("job_status")),job,event)
            .stream().findFirst().orElseThrow(()->new WorkerException(404,"WORKER_DELIVERY_NOT_FOUND"));
    }
    /** Caller holds Meeting first; job lock serializes worker commands and sweeper. */
    public void lockJob(UUID job) {
        jdbc.queryForObject("SELECT id FROM processing_jobs WHERE id=? FOR UPDATE",UUID.class,job);
    }
    public Optional<Claim> claim(UUID event) {
        return jdbc.query("""
            SELECT c.*,s.status,s.lease_expires_at,
              (s.status='RUNNING' AND s.lease_expires_at>clock_timestamp()
               AND j.status='RUNNING' AND j.current_stage=s.stage_code AND s.attempt_number=(
                 SELECT max(x.attempt_number) FROM processing_stage_runs x
                 WHERE x.processing_job_id=s.processing_job_id AND x.stage_code=s.stage_code)) AS live
            FROM transcription_worker_claims c JOIN processing_stage_runs s ON s.id=c.execution_stage_run_id
            JOIN processing_jobs j ON j.id=c.processing_job_id WHERE c.event_id=?
            """,(r,n)->new Claim(event,r.getObject("execution_stage_run_id",UUID.class),r.getObject("claim_token",UUID.class),
                r.getString("execution_stage_code"),r.getObject("claim_request_id",UUID.class),r.getString("request_sha256"),
                MAPPER.readTree(r.getString("source_descriptor")),r.getObject("reusable_producer_id",UUID.class),
                r.getString("status"),r.getObject("lease_expires_at",OffsetDateTime.class),r.getBoolean("live")),event).stream().findFirst();
    }
    public JsonNode source(Delivery d,String storageId) {
        return jdbc.<JsonNode>query("""
            SELECT * FROM meeting_media WHERE id=? AND meeting_id=? AND status='AVAILABLE'
              AND sha256 ~ '^[a-f0-9]{64}$' AND size_bytes>0 AND duration_ms>0
            """,(r,n)->MAPPER.valueToTree(Map.of("sourceMediaId",d.mediaId().toString(),"sourceRevision",r.getString("sha256"),
                "storageId",storageId,"objectKey",r.getString("object_key"),"contentType",r.getString("content_type"),
                "sizeBytes",r.getLong("size_bytes"),"sha256",r.getString("sha256"),"durationMs",r.getLong("duration_ms"))),d.mediaId(),d.meetingId())
            .stream().findFirst().orElseThrow(()->new WorkerException(503,"SOURCE_MEDIA_MISSING"));
    }
    public String nextStage(UUID job) {
        var stages=jdbc.query("""
            SELECT DISTINCT ON(stage_code) stage_code,status FROM processing_stage_runs
            WHERE processing_job_id=? ORDER BY stage_code,attempt_number DESC
            """,(r,n)->Map.entry(r.getString("stage_code"),r.getString("status")),job);
        require(stages.stream().anyMatch(s->s.getKey().equals("CONTEXTUAL_CORRECTION")));
        for (String code:List.of("TRANSCRIPTION","CONTEXTUAL_CORRECTION","FINALIZING_TRANSCRIPT")) {
            var status=stages.stream().filter(s->s.getKey().equals(code)).map(Map.Entry::getValue).findFirst();
            if(status.isEmpty() || status.get().equals("PENDING")) return code;
            if(!List.of("SUCCEEDED","SUCCEEDED_WITH_WARNING").contains(status.get()))
                throw WorkerException.conflict("WORKER_ATTEMPT_BUSY");
        }
        throw WorkerException.conflict("WORKER_IDENTITY_CONFLICT");
    }
    public void insertClaim(Delivery d,WorkerCommands.Claim request,com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim owner,
            String stage,JsonNode source,UUID reuse) {
        if(Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM transcription_worker_claims WHERE claim_request_id=?)",Boolean.class,request.claimRequestId())))
            throw WorkerException.conflict("WORKER_COMMAND_CONFLICT");
        jdbc.update("""
            INSERT INTO transcription_worker_claims(event_id,processing_job_id,principal,claim_request_id,request_sha256,
                execution_stage_run_id,execution_stage_code,claim_token,source_descriptor,reusable_producer_id)
            VALUES (?,?,'urn:sme:service:ai-worker',?,?,?,?,?,CAST(? AS jsonb),?)
            """,d.eventId(),d.jobId(),request.claimRequestId(),WorkerCommands.fingerprint(request),owner.stageRunId(),stage,
            owner.claimToken(),source.toString(),reuse);
    }
    public Optional<Receipt> receipt(UUID job,UUID event) {
        return receipts("WHERE r.processing_job_id=? AND (r.event_id=? OR r.outcome='RESULT_ACCEPTED') ORDER BY (r.event_id=?) DESC LIMIT 1",job,event,event)
            .stream().findFirst();
    }
    public Optional<Receipt> command(UUID command) {
        return receipts("WHERE r.command_id=?",command).stream().findFirst();
    }
    private List<Receipt> receipts(String where,Object... args) {
        return jdbc.query("""
            SELECT r.*,v.result_sha256,v.correction_sha256 FROM transcription_worker_receipts r
            LEFT JOIN transcription_worker_results v ON v.producer_stage_run_id=r.producer_stage_run_id
            """+where,(r,n)->new Receipt(r.getObject("receipt_id",UUID.class),r.getObject("event_id",UUID.class),r.getString("outcome"),
            r.getObject("command_id",UUID.class),r.getString("command_sha256"),r.getObject("execution_stage_run_id",UUID.class),
            r.getObject("producer_stage_run_id",UUID.class),r.getString("result_sha256"),r.getString("correction_sha256"),
            r.getObject("transcript_id",UUID.class),r.getString("transcript_status"),r.getString("error_code"),
            (Boolean)r.getObject("retryable"),(Boolean)r.getObject("retry_exhausted"),r.getObject("recorded_at",OffsetDateTime.class)),args);
    }
    public void failure(Delivery d,Claim c,UUID command,String fingerprint,String error,boolean retryable,boolean exhausted) {
        jdbc.update("""
            INSERT INTO transcription_worker_receipts(receipt_id,event_id,processing_job_id,execution_stage_run_id,
                command_id,command_sha256,outcome,error_code,retryable,retry_exhausted)
            VALUES (?,?,?,?,?,?,'FAILURE_RECORDED',?,?,?)
            """,UUID.randomUUID(),d.eventId(),d.jobId(),c.stageId(),command,fingerprint,error,retryable,exhausted);
    }
    public void acceptance(Delivery d,Claim c,WorkerCommands.Complete cmd,UUID transcript,String status) {
        jdbc.update("""
            INSERT INTO transcription_worker_receipts(receipt_id,event_id,processing_job_id,execution_stage_run_id,
                command_id,command_sha256,outcome,producer_stage_run_id,transcript_id,transcript_status)
            VALUES (?,?,?,?,?,?,'RESULT_ACCEPTED',?,?,?)
            """,UUID.randomUUID(),d.eventId(),d.jobId(),c.stageId(),cmd.commandId(),WorkerCommands.fingerprint(cmd),
            cmd.resultProducerStageRunId(),transcript,status);
    }
    public Optional<UUID> reusable(UUID job,String revision) {
        return jdbc.query("""
            SELECT producer_stage_run_id FROM transcription_worker_results
            WHERE processing_job_id=? AND source_revision=? ORDER BY verified_at DESC LIMIT 1
            """,(r,n)->r.getObject(1,UUID.class),job,revision).stream().findFirst();
    }
    public void verifiedResult(Delivery d,Claim c,WorkerCommands.Complete cmd,CorrectedTranscript result,int size) {
        jdbc.update("""
            INSERT INTO transcription_worker_results(producer_stage_run_id,processing_job_id,source_revision,
                result_sha256,correction_sha256,storage_id,object_key,size_bytes,warning_count,metadata)
            VALUES (?,?,?,?,?,?,?,?,?,CAST(? AS jsonb)) ON CONFLICT(producer_stage_run_id) DO NOTHING
            """,cmd.resultProducerStageRunId(),d.jobId(),result.sourceRevision(),cmd.resultSha256(),result.correctionDigest(),
            c.source().get("storageId").asString(),resultKey(d.jobId(),cmd.resultProducerStageRunId()),size,result.warningCount(),result.metadata().toString());
        if (!Boolean.TRUE.equals(jdbc.queryForObject("""
            SELECT EXISTS(SELECT 1 FROM transcription_worker_results WHERE producer_stage_run_id=?
                AND processing_job_id=? AND source_revision=? AND result_sha256=? AND correction_sha256=?)
            """,Boolean.class,cmd.resultProducerStageRunId(),d.jobId(),result.sourceRevision(),cmd.resultSha256(),result.correctionDigest())))
            throw WorkerException.conflict("WORKER_RESULT_CONFLICT");
    }
    public String correctionProof(UUID job) {
        return jdbc.query("""
            SELECT metrics::text FROM processing_stage_runs WHERE processing_job_id=? AND stage_code='CONTEXTUAL_CORRECTION'
            ORDER BY attempt_number DESC LIMIT 1
            """,(r,n)->r.getString(1),job).stream().findFirst().orElse(null);
    }
    public OffsetDateTime now() { return jdbc.queryForObject("SELECT clock_timestamp()",OffsetDateTime.class); }
    public static String resultKey(UUID job,UUID stage) { return "processing/"+job+"/transcription/results/"+stage+".json"; }
}
