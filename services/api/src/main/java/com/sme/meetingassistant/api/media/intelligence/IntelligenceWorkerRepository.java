package com.sme.meetingassistant.api.media.intelligence;

import com.sme.meetingassistant.api.media.worker.WorkerException;
import java.time.OffsetDateTime;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Media-owned dispatch/ownership metadata; canonical results stay behind the feature evidence port. */
@Repository
public class IntelligenceWorkerRepository {
    private final JdbcTemplate jdbc;
    public IntelligenceWorkerRepository(JdbcTemplate jdbc) {this.jdbc=jdbc;}
    public record Delivery(UUID job,UUID meeting,UUID media,boolean derived,String jobStatus,String mediaStatus,
        UUID event,UUID stage,String code,int schema,int attempt,int latest,String status,UUID token,
        OffsetDateTime expires,boolean live,String error,boolean retryable,String publication) {}
    public record Claim(UUID request,String fingerprint,String peer,UUID snapshot,UUID failureCommand,String failureFingerprint) {}
    public Delivery delivery(UUID job,UUID event) {
        return jdbc.query("""
            SELECT j.id,j.meeting_id,j.source_media_id,j.job_type,j.status AS job_status,
              CASE WHEN m.status='AVAILABLE' AND m.sha256 ~ '^[a-f0-9]{64}$' AND m.size_bytes>0 AND m.duration_ms>0
                AND m.available_at IS NOT NULL AND m.object_key=('meetings/' || j.meeting_id || '/sources/' || m.id)
                THEN 'AVAILABLE' ELSE 'INELIGIBLE' END AS media_status,
              d.event_id,d.stage_run_id,d.stage_code,d.schema_version,s.attempt_number,s.status,s.claim_token,
              s.lease_expires_at,s.error_code,s.retryable,e.status AS publication,
              (j.status='RUNNING' AND s.status='RUNNING' AND s.lease_expires_at>clock_timestamp()
                AND s.attempt_number=(SELECT MAX(x.attempt_number) FROM processing_stage_runs x
                    WHERE x.processing_job_id=j.id AND x.stage_code=s.stage_code)) AS live,
              (SELECT MAX(x.attempt_number) FROM processing_stage_runs x
                WHERE x.processing_job_id=j.id AND x.stage_code=s.stage_code) AS latest
            FROM processing_intelligence_dispatches d JOIN processing_jobs j ON j.id=d.processing_job_id
            JOIN processing_stage_runs s ON s.id=d.stage_run_id AND s.processing_job_id=j.id AND s.stage_code=d.stage_code
            JOIN meeting_media m ON m.id=j.source_media_id AND m.meeting_id=j.meeting_id
            JOIN outbox_events e ON e.id=d.event_id AND e.aggregate_id=j.id AND e.aggregate_type='PROCESSING_JOB'
              AND e.event_type='PROCESSING_INTELLIGENCE_STAGE_REQUESTED'
              AND e.payload->>'eventId'=d.event_id::text AND e.payload->>'processingJobId'=j.id::text
              AND e.payload->>'executionStageRunId'=s.id::text AND e.payload->>'executionStageCode'=s.stage_code
              AND e.payload->'schemaVersion'='1'::jsonb
            WHERE j.id=? AND d.event_id=?
            """,(r,n)->new Delivery(r.getObject("id",UUID.class),r.getObject("meeting_id",UUID.class),
                r.getObject("source_media_id",UUID.class),"DERIVED_STAGE_PROCESSING".equals(r.getString("job_type")),
                r.getString("job_status"),r.getString("media_status"),r.getObject("event_id",UUID.class),r.getObject("stage_run_id",UUID.class),
                r.getString("stage_code"),r.getInt("schema_version"),r.getInt("attempt_number"),r.getInt("latest"),r.getString("status"),
                r.getObject("claim_token",UUID.class),r.getObject("lease_expires_at",OffsetDateTime.class),r.getBoolean("live"),
                r.getString("error_code"),r.getBoolean("retryable"),r.getString("publication")),job,event).stream().findFirst()
            .orElseThrow(()->new WorkerException(404,"WORKER_DELIVERY_NOT_FOUND"));
    }
    public void lockJob(UUID job) {jdbc.queryForObject("SELECT id FROM processing_jobs WHERE id=? FOR UPDATE",UUID.class,job);}
    public Optional<Claim> claim(UUID event) {
        return jdbc.query("SELECT * FROM processing_intelligence_claims WHERE event_id=?",(r,n)->new Claim(
            r.getObject("claim_request_id",UUID.class),r.getString("command_fingerprint"),r.getString("owner_certificate_sha256"),
            r.getObject("source_snapshot_id",UUID.class),r.getObject("failure_command_id",UUID.class),r.getString("failure_fingerprint")),event).stream().findFirst();
    }
    public void insertClaim(Delivery d,IntelligenceCommands.Claim command,String peer,UUID snapshot) {
        jdbc.update("""
            INSERT INTO processing_intelligence_claims(event_id,processing_job_id,stage_run_id,claim_request_id,
              command_fingerprint,owner_certificate_sha256,source_snapshot_id) VALUES (?,?,?,?,?,?,?)
            """,d.event(),d.job(),d.stage(),command.claimRequestId(),IntelligenceCommands.fingerprint(command),peer,snapshot);
    }
    public void recordFailure(UUID event,IntelligenceCommands.Fail command) {
        jdbc.update("UPDATE processing_intelligence_claims SET failure_command_id=?,failure_fingerprint=? WHERE event_id=? AND failure_command_id IS NULL",
            command.commandId(),IntelligenceCommands.fingerprint(command),event);
    }
    public OffsetDateTime now() {return jdbc.queryForObject("SELECT clock_timestamp()",OffsetDateTime.class);}
}
