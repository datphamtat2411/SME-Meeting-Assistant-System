package com.sme.meetingassistant.api.media.worker;

import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import java.util.Objects;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Durable DLQ disposition, serialized with completion, retry admission and sweeper. */
@Service
public class DeadLetterReconciliation {
    private final JdbcTemplate jdbc;
    private final TranscriptionWorkerRepository repository;
    private final ProcessingJobLifecycle lifecycle;
    public DeadLetterReconciliation(JdbcTemplate jdbc,TranscriptionWorkerRepository repository,ProcessingJobLifecycle lifecycle) {
        this.jdbc=jdbc; this.repository=repository; this.lifecycle=lifecycle;
    }
    @Transactional
    public void quarantine(String hash,String reason,int size) {
        jdbc.update("INSERT INTO transcription_worker_quarantine(evidence_sha256,reason,body_size) VALUES (?,?,?) ON CONFLICT DO NOTHING",hash,reason,size);
    }
    @Transactional
    public String reconcile(DeadLetterEvent event) {
        TranscriptionWorkerRepository.Delivery d;
        try { d=repository.delivery(event.job(),event.event()); }
        catch(WorkerException unknown) { quarantine(event.evidence(),"UNKNOWN_BINDING",0); return "QUARANTINED"; }
        if(!d.meetingId().equals(event.meeting()) || !d.mediaId().equals(event.media()) || !d.requester().equals(event.requester())
                || d.generation()!=event.generation() || !d.eventType().equals(event.type()) || d.schemaVersion()!=event.version()
                || !Objects.equals(d.retryFromStage(),event.retryStage())) {
            quarantine(event.evidence(),"IDENTITY_CONFLICT",0); return "QUARANTINED";
        }
        // Same global ordering as publication: Meeting -> job -> stages/receipts.
        jdbc.queryForObject("SELECT id FROM meetings WHERE id=? FOR UPDATE",UUID.class,d.meetingId());
        repository.lockJob(d.jobId()); d=repository.delivery(d.jobId(),d.eventId());
        var prior=jdbc.query("SELECT disposition FROM transcription_worker_reconciliations WHERE event_id=?",(r,n)->r.getString(1),d.eventId());
        if(!prior.isEmpty() && !prior.getFirst().equals("DEFERRED")) return prior.getFirst();
        String disposition;
        if(repository.receipt(d.jobId(),d.eventId()).isPresent()) disposition="TERMINAL";
        else if(d.generation()<d.currentGeneration()) disposition="SUPERSEDED";
        else if(Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM processing_stage_runs WHERE processing_job_id=? AND status='RUNNING')",Boolean.class,d.jobId()))) {
            // Includes expired claims: the existing sweeper records STAGE_LEASE_EXPIRED.
            // Durable obligation survives ACK, restart and disappearance of the broker copy.
            disposition="DEFERRED";
        } else if(d.currentGeneration()!=d.generation() || d.generation()>3 || !java.util.List.of("PENDING","QUEUED").contains(d.jobStatus())
                || d.retryFromStage()!=null && !java.util.List.of("TRANSCRIPTION","CONTEXTUAL_CORRECTION","FINALIZING_TRANSCRIPT").contains(d.retryFromStage())) {
            disposition="OPERATOR_REVIEW";
        } else {
            String stage;
            try { stage=repository.nextStage(d.jobId()); }
            catch(WorkerException conflict) { return save(d,event.evidence(),"OPERATOR_REVIEW"); }
            // Core owns this short lifecycle transition. No worker claim/token is fabricated.
            var claim=lifecycle.startTranscriptionWorkerStage(d.jobId(),stage);
            boolean exhausted=d.generation()>=3;
            lifecycle.failStage(claim,"WORKER_DELIVERY_EXHAUSTED",null,!exhausted);
            jdbc.update("""
                INSERT INTO transcription_worker_receipts(receipt_id,event_id,processing_job_id,outcome,error_code,retryable,retry_exhausted)
                VALUES (?,?,?,'FAILURE_RECORDED','WORKER_DELIVERY_EXHAUSTED',?,?)
                """,UUID.randomUUID(),d.eventId(),d.jobId(),!exhausted,exhausted);
            disposition="EXHAUSTED";
        }
        return save(d,event.evidence(),disposition);
    }
    private String save(TranscriptionWorkerRepository.Delivery d,String evidence,String disposition) {
        jdbc.update("""
            INSERT INTO transcription_worker_reconciliations(event_id,processing_job_id,evidence_sha256,disposition)
            VALUES (?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET disposition=EXCLUDED.disposition,checked_at=clock_timestamp()
            """,d.eventId(),d.jobId(),evidence,disposition);
        return disposition;
    }
}
