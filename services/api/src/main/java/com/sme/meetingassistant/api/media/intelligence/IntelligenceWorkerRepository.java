package com.sme.meetingassistant.api.media.intelligence;

import com.sme.meetingassistant.api.media.worker.WorkerException;
import java.math.BigDecimal;
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
    public record BudgetLimits(int summaryAttempts,int decisionAttempts,int actionItemAttempts,int aggregateAttempts,
        long reservedTokens,BigDecimal estimatedCost,BigDecimal inputCost,BigDecimal outputCost) {}
    public record Budget(UUID job,int summaryCeiling,int decisionCeiling,int actionItemCeiling,int aggregateCeiling,
        long tokenCeiling,BigDecimal costCeiling,BigDecimal inputCost,BigDecimal outputCost,
        int reservedAttempts,int summaryAttempts,int decisionAttempts,int actionItemAttempts,
        long reservedTokens,BigDecimal estimatedCost,BigDecimal reportedCost) {}
    public record ProviderAttempt(UUID id,UUID job,UUID event,UUID stage,String code,String reserveFingerprint,
        long inputEstimate,long outputCeiling,long reservedTokens,BigDecimal estimatedCost,String outcome,
        Long inputTokens,Long outputTokens,Long totalTokens,Long reasoningTokens,BigDecimal reportedCost,
        String reportFingerprint,OffsetDateTime reservedAt,OffsetDateTime reportedAt) {}
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
    public void ensureBudget(UUID job,BudgetLimits limits) {
        jdbc.update("""
            INSERT INTO processing_intelligence_budgets(processing_job_id,summary_attempt_ceiling,
              decision_attempt_ceiling,action_item_attempt_ceiling,aggregate_attempt_ceiling,
              reserved_token_ceiling,estimated_cost_ceiling_usd,input_cost_per_million_usd,
              output_cost_per_million_usd)
            VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT (processing_job_id) DO NOTHING
            """,job,limits.summaryAttempts(),limits.decisionAttempts(),limits.actionItemAttempts(),
            limits.aggregateAttempts(),limits.reservedTokens(),limits.estimatedCost(),
            limits.inputCost(),limits.outputCost());
        // Changes to deployment policy do not refill or invalidate an existing job ledger.
    }
    public Budget budget(UUID job) {
        return jdbc.query("""
            SELECT * FROM processing_intelligence_budgets WHERE processing_job_id=? FOR UPDATE
            """,(r,n)->new Budget(r.getObject("processing_job_id",UUID.class),
                r.getInt("summary_attempt_ceiling"),r.getInt("decision_attempt_ceiling"),
                r.getInt("action_item_attempt_ceiling"),r.getInt("aggregate_attempt_ceiling"),
                r.getLong("reserved_token_ceiling"),r.getBigDecimal("estimated_cost_ceiling_usd"),
                r.getBigDecimal("input_cost_per_million_usd"),r.getBigDecimal("output_cost_per_million_usd"),
                r.getInt("reserved_attempts"),r.getInt("summary_attempts"),r.getInt("decision_attempts"),
                r.getInt("action_item_attempts"),r.getLong("reserved_tokens"),
                r.getBigDecimal("estimated_cost_usd"),r.getBigDecimal("reported_cost_usd")),job)
            .stream().findFirst().orElseThrow(()->WorkerException.conflict("WORKER_BUDGET_NOT_FOUND"));
    }
    public Optional<ProviderAttempt> providerAttempt(UUID attempt) {
        return jdbc.query("""
            SELECT * FROM processing_intelligence_provider_attempts WHERE attempt_id=?
            """,(r,n)->new ProviderAttempt(r.getObject("attempt_id",UUID.class),
                r.getObject("processing_job_id",UUID.class),r.getObject("event_id",UUID.class),
                r.getObject("stage_run_id",UUID.class),r.getString("stage_code"),
                r.getString("reserve_fingerprint"),r.getLong("reserved_input_tokens"),
                r.getLong("output_token_ceiling"),r.getLong("reserved_tokens"),
                r.getBigDecimal("estimated_cost_usd"),r.getString("outcome"),
                (Long)r.getObject("input_tokens"),(Long)r.getObject("output_tokens"),
                (Long)r.getObject("total_tokens"),(Long)r.getObject("reasoning_tokens"),
                r.getBigDecimal("reported_cost_usd"),r.getString("report_fingerprint"),
                r.getObject("reserved_at",OffsetDateTime.class),r.getObject("reported_at",OffsetDateTime.class)),attempt)
            .stream().findFirst();
    }
    public void insertProviderAttempt(IntelligenceCommands.AttemptReserve command,UUID job,
            String fingerprint) {
        jdbc.update("""
            INSERT INTO processing_intelligence_provider_attempts(attempt_id,processing_job_id,event_id,
              stage_run_id,stage_code,reserve_fingerprint,reserved_input_tokens,output_token_ceiling,
              reserved_tokens,estimated_cost_usd)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            """,command.attemptId(),job,command.eventId(),command.executionStageRunId(),
            command.executionStageCode(),fingerprint,command.estimatedInputTokens(),command.outputTokenCeiling(),
            command.reservedTokens(),command.estimatedCostUsd());
    }
    public void incrementBudget(UUID job,String stage,long tokens,BigDecimal cost) {
        String column=switch(stage) {
            case "GENERATING_SUMMARY" -> "summary_attempts";
            case "EXTRACTING_DECISIONS" -> "decision_attempts";
            case "EXTRACTING_ACTION_ITEMS" -> "action_item_attempts";
            default -> throw WorkerException.conflict("WORKER_IDENTITY_CONFLICT");
        };
        jdbc.update("""
            UPDATE processing_intelligence_budgets
            SET reserved_attempts=reserved_attempts+1,%s=%s+1,
                reserved_tokens=reserved_tokens+?,estimated_cost_usd=estimated_cost_usd+?
            WHERE processing_job_id=?
            """.formatted(column,column),tokens,cost,job);
    }
    public void reportProviderAttempt(IntelligenceCommands.AttemptReport command,String fingerprint) {
        jdbc.update("""
            UPDATE processing_intelligence_provider_attempts
            SET outcome=?,input_tokens=?,output_tokens=?,total_tokens=?,reasoning_tokens=?,
                reported_cost_usd=?,report_fingerprint=?,reported_at=CURRENT_TIMESTAMP
            WHERE attempt_id=? AND outcome='RESERVED'
            """,command.outcome(),command.inputTokens(),command.outputTokens(),command.totalTokens(),
            command.reasoningTokens(),command.reportedCostUsd(),fingerprint,command.attemptId());
        if(command.reportedCostUsd()!=null) jdbc.update("""
            UPDATE processing_intelligence_budgets b
            SET reported_cost_usd=b.reported_cost_usd+?
            FROM processing_intelligence_provider_attempts a
            WHERE b.processing_job_id=a.processing_job_id AND a.attempt_id=?
            """,command.reportedCostUsd(),command.attemptId());
    }
    public OffsetDateTime now() {return jdbc.queryForObject("SELECT clock_timestamp()",OffsetDateTime.class);}
}
