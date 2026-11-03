package com.sme.meetingassistant.api.media.worker;

import static com.sme.meetingassistant.api.media.worker.WorkerJson.*;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.media.repository.MediaRepository.ProcessingLifecycleConflictException;
import com.sme.meetingassistant.api.media.worker.TranscriptionWorkerRepository.*;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.annotation.Propagation;

/** Capability-specific Media application boundary; no parallel processing status. */
@Service
public class TranscriptionWorkerService {
    private final TranscriptionWorkerRepository repository;
    private final ProcessingJobLifecycle lifecycle;
    private final TranscriptionWorkerCapability capability;
    public TranscriptionWorkerService(TranscriptionWorkerRepository repository,ProcessingJobLifecycle lifecycle,TranscriptionWorkerCapability capability) {
        this.repository=repository; this.lifecycle=lifecycle; this.capability=capability;
    }
    public Delivery delivery(UUID job,UUID event) { capability.requireAvailable(); return repository.delivery(job,event); }
    @Transactional(readOnly=true)
    public Map<String,Object> status(UUID job,UUID event) { return status(delivery(job,event),null); }
    private Map<String,Object> status(Delivery d,Boolean replay) {
        var data=new LinkedHashMap<String,Object>(); data.put("contractVersion","1.0"); data.put("processingJobId",d.jobId());
        data.put("eventId",d.eventId()); data.put("generation",d.generation());
        var receipt=repository.receipt(d.jobId(),d.eventId());
        String state; Object representation=null;
        if(receipt.isPresent()) {
            var r=receipt.get(); state=r.eventId().equals(d.eventId())?r.state():"SUPERSEDED";
            representation=state.equals("SUPERSEDED")?Map.of("coveringReceiptId",r.id()):receiptData(r);
        } else if(d.generation()<d.currentGeneration()) {
            state="SUPERSEDED"; representation=Map.of("generation",d.currentGeneration());
        } else {
            var claim=repository.claim(d.eventId());
            state=claim.isPresent()?(claim.get().live()?"RUNNING":"AWAITING_RECONCILIATION"):
                (List.of("PENDING","QUEUED").contains(d.jobStatus())?"AVAILABLE":"AWAITING_RECONCILIATION");
        }
        data.put("state",state); data.put("receipt",representation); if(replay!=null) data.put("replay",replay); return data;
    }
    private Map<String,Object> receiptData(Receipt r) {
        if(r.state().equals("RESULT_ACCEPTED")) return Map.of("receiptId",r.id(),"resultSha256",r.resultDigest(),
            "correctionSha256",r.correctionDigest(),"transcriptId",r.transcriptId(),"transcriptStatus",r.transcriptStatus(),"acceptedAt",r.recordedAt());
        return Map.of("receiptId",r.id(),"errorCode",r.errorCode(),"retryable",r.retryable(),"retryExhausted",r.exhausted(),"recordedAt",r.recordedAt());
    }
    private boolean terminal(Delivery d) { return repository.receipt(d.jobId(),d.eventId()).isPresent() || d.generation()<d.currentGeneration(); }
    @Transactional
    public Map<String,Object> claim(UUID job,WorkerCommands.Claim cmd) {
        delivery(job,cmd.eventId()); repository.lockJob(job); var d=repository.delivery(job,cmd.eventId());
        if(d.generation()!=cmd.generation() || !d.eventType().equals(cmd.eventType()) || d.schemaVersion()!=cmd.eventSchemaVersion()
            || !d.meetingId().equals(cmd.meetingId()) || !d.mediaId().equals(cmd.sourceMediaId()) || !d.requester().equals(cmd.requestedByUserId()))
            throw WorkerException.conflict("WORKER_IDENTITY_CONFLICT");
        if(terminal(d)) return status(d,null);
        if(d.currentGeneration()!=d.generation() || d.generation()>3) throw WorkerException.conflict("WORKER_IDENTITY_CONFLICT");
        var existing=repository.claim(d.eventId());
        if(existing.isPresent()) {
            var c=existing.get();
            if(!c.requestId().equals(cmd.claimRequestId())) throw WorkerException.conflict("WORKER_ATTEMPT_BUSY");
            if(!c.requestDigest().equals(WorkerCommands.fingerprint(cmd))) throw WorkerException.conflict("WORKER_COMMAND_CONFLICT");
            if(!c.live()) throw WorkerException.conflict("WORKER_LEASE_LOST");
            return claimData(d,c);
        }
        if(d.retryFromStage()!=null && !List.of("TRANSCRIPTION","CONTEXTUAL_CORRECTION","FINALIZING_TRANSCRIPT").contains(d.retryFromStage()))
            throw WorkerException.conflict("WORKER_IDENTITY_CONFLICT");
        var source=repository.source(d,capability.storageId());
        String stage=repository.nextStage(job);
        var reuse=repository.reusable(job,source.get("sourceRevision").asString()).orElse(null);
        try {
            StageClaim owner=lifecycle.startTranscriptionWorkerStage(job,stage);
            repository.insertClaim(d,cmd,owner,stage,source,reuse);
        } catch(ProcessingLifecycleConflictException e) { throw WorkerException.conflict("WORKER_ATTEMPT_BUSY"); }
        return claimData(d,repository.claim(d.eventId()).orElseThrow());
    }
    private Map<String,Object> claimData(Delivery d,Claim c) {
        var data=new LinkedHashMap<String,Object>();
        data.put("contractVersion","1.0"); data.put("processingJobId",d.jobId()); data.put("meetingId",d.meetingId()); data.put("sourceMediaId",d.mediaId());
        data.put("eventId",d.eventId()); data.put("generation",d.generation()); data.put("executionStageRunId",c.stageId()); data.put("executionStageCode",c.stageCode());
        data.put("claimToken",c.token()); data.put("leaseExpiresAt",c.leaseExpiresAt()); data.put("serverTime",repository.now());
        data.put("leaseSeconds",120); data.put("renewAfterSeconds",30); data.put("source",c.source());
        String storage=c.source().get("storageId").asString();
        data.put("resultSlot",Map.of("storageId",storage,"objectKey",TranscriptionWorkerRepository.resultKey(d.jobId(),c.stageId()),"maxBytes",CorrectedTranscript.MAX_BYTES));
        data.put("reusableResult",c.reusableProducer()==null?null:Map.of("storageId",storage,"objectKey",TranscriptionWorkerRepository.resultKey(d.jobId(),c.reusableProducer()),"producerStageRunId",c.reusableProducer()));
        return data;
    }
    public Claim requireOwner(Delivery d,WorkerCommands.Owner owner,boolean live) {
        if(d.generation()!=owner.generation()) throw WorkerException.conflict("WORKER_IDENTITY_CONFLICT");
        var c=repository.claim(d.eventId()).orElseThrow(()->WorkerException.conflict("WORKER_LEASE_LOST"));
        if(!c.stageId().equals(owner.executionStageRunId()) || !c.token().equals(owner.claimToken())
            || live && (!c.live() || d.currentGeneration()!=d.generation() || terminal(d))) throw WorkerException.conflict("WORKER_LEASE_LOST");
        return c;
    }
    @Transactional
    public Map<String,Object> renew(UUID job,WorkerCommands.Owner owner) {
        delivery(job,owner.eventId()); repository.lockJob(job); var d=repository.delivery(job,owner.eventId()); var c=requireOwner(d,owner,true);
        try { lifecycle.renewTranscriptionWorkerLease(new StageClaim(c.stageId(),c.token())); }
        catch(ProcessingLifecycleConflictException e) { throw WorkerException.conflict("WORKER_LEASE_LOST"); }
        var renewed=repository.claim(d.eventId()).orElseThrow();
        return Map.of("contractVersion","1.0","leaseExpiresAt",renewed.leaseExpiresAt(),"serverTime",repository.now(),"renewAfterSeconds",30);
    }
    /** Read-only exact replay before any storage access; original token is required, lease is not. */
    @Transactional(readOnly=true)
    public Map<String,Object> completionReplay(UUID job,WorkerCommands.Complete cmd) {
        var d=delivery(job,cmd.owner().eventId()); var r=repository.receipt(job,d.eventId());
        var priorCommand=repository.command(cmd.commandId());
        if(r.isEmpty()) {
            if(priorCommand.isPresent() && !WorkerCommands.fingerprint(cmd).equals(priorCommand.get().commandDigest()))
                throw WorkerException.conflict("WORKER_COMMAND_CONFLICT");
            return null;
        }
        var receipt=r.get();
        if(!receipt.state().equals("RESULT_ACCEPTED")) throw WorkerException.conflict("WORKER_COMMAND_CONFLICT");
        requireOwner(d,cmd.owner(),false);
        if(!receipt.resultDigest().equals(cmd.resultSha256()) || !receipt.producerId().equals(cmd.resultProducerStageRunId()))
            throw WorkerException.conflict("WORKER_RESULT_CONFLICT");
        if(!receipt.eventId().equals(d.eventId()) || !receipt.stageId().equals(cmd.owner().executionStageRunId())
            || !cmd.commandId().equals(receipt.commandId()) || !WorkerCommands.fingerprint(cmd).equals(receipt.commandDigest()))
            throw WorkerException.conflict("WORKER_COMMAND_CONFLICT");
        return status(d,true);
    }
    public Claim completionSource(UUID job,WorkerCommands.Complete cmd) {
        var d=delivery(job,cmd.owner().eventId()); var c=requireOwner(d,cmd.owner(),true);
        if(!cmd.resultProducerStageRunId().equals(c.stageId()) && !cmd.resultProducerStageRunId().equals(c.reusableProducer()))
            throw WorkerException.conflict("WORKER_IDENTITY_CONFLICT");
        if(c.stageCode().equals("FINALIZING_TRANSCRIPT") && !cmd.resultProducerStageRunId().equals(c.reusableProducer()))
            throw new WorkerException(422,"TRANSCRIPT_RESULT_MISSING");
        return c;
    }
    @Transactional
    public void registerVerified(UUID job,WorkerCommands.Complete cmd,CorrectedTranscript result,int size) {
        repository.lockJob(job);
        if(completionReplay(job,cmd)!=null) return;
        var d=delivery(job,cmd.owner().eventId()); var c=completionSource(job,cmd);
        repository.verifiedResult(d,c,cmd,result,size);
    }
    @Transactional(propagation=Propagation.MANDATORY)
    public StageClaim projectOrReplay(UUID job,WorkerCommands.Complete cmd,CorrectedTranscript result) {
        repository.lockJob(job);
        if(completionReplay(job,cmd)!=null) return null;
        var d=delivery(job,cmd.owner().eventId()); var c=completionSource(job,cmd);
        if(!sameSource(repository.source(d,capability.storageId()),c.source()) || !result.sourceRevision().equals(c.source().get("sourceRevision").asString()))
            throw WorkerException.conflict("WORKER_IDENTITY_CONFLICT");
        StageClaim stage=new StageClaim(c.stageId(),c.token());
        String outcome=result.status()==com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.Status.READY?"SUCCEEDED":"SUCCEEDED_WITH_WARNING";
        if(c.stageCode().equals("TRANSCRIPTION")) {
            lifecycle.completeStage(stage,outcome,null,"{\"speech_coverage_validated\":true}");
            stage=lifecycle.startTranscriptionWorkerStage(job,"CONTEXTUAL_CORRECTION");
        }
        if(!c.stageCode().equals("FINALIZING_TRANSCRIPT")) {
            lifecycle.completeStage(stage,outcome,null,result.proofJson());
            stage=lifecycle.startTranscriptionWorkerStage(job,"FINALIZING_TRANSCRIPT");
        } else {
            String proof=repository.correctionProof(job);
            if(proof==null) throw WorkerException.conflict("WORKER_RESULT_CONFLICT");
            var stored=MAPPER.readTree(proof); var expected=MAPPER.readTree(result.proofJson());
            for(String field:List.of("contextScope","outputSha256","promptVersion"))
                if(!expected.get(field).equals(stored.get(field))) throw WorkerException.conflict("WORKER_RESULT_CONFLICT");
        }
        return stage;
    }
    private static boolean sameSource(tools.jackson.databind.JsonNode current,tools.jackson.databind.JsonNode claimed) {
        // JSONB normalizes integral widths. Compare typed descriptor values, not IntNode vs LongNode identity.
        for(String field:List.of("sourceMediaId","sourceRevision","storageId","objectKey","contentType","sha256"))
            if(!current.get(field).asString().equals(claimed.get(field).asString())) return false;
        return current.get("sizeBytes").longValue()==claimed.get("sizeBytes").longValue()
            && current.get("durationMs").longValue()==claimed.get("durationMs").longValue();
    }
    @Transactional(propagation=Propagation.MANDATORY)
    public Map<String,Object> accept(UUID job,WorkerCommands.Complete cmd,UUID transcript,String transcriptStatus) {
        var d=delivery(job,cmd.owner().eventId()); var c=requireOwner(d,cmd.owner(),false);
        repository.acceptance(d,c,cmd,transcript,transcriptStatus); return status(d,false);
    }
    @Transactional
    public Map<String,Object> fail(UUID job,WorkerCommands.Fail cmd) {
        delivery(job,cmd.owner().eventId()); repository.lockJob(job); var d=repository.delivery(job,cmd.owner().eventId());
        var existing=repository.receipt(job,d.eventId());
        var c=requireOwner(d,cmd.owner(),false);
        if(existing.isPresent() && existing.get().state().equals("RESULT_ACCEPTED")) return status(d,true);
        String fingerprint=WorkerCommands.fingerprint(cmd);
        var priorCommand=repository.command(cmd.commandId());
        if(priorCommand.isPresent() && !fingerprint.equals(priorCommand.get().commandDigest())) throw WorkerException.conflict("WORKER_COMMAND_CONFLICT");
        if(existing.isPresent()) {
            if(!cmd.commandId().equals(existing.get().commandId()) || !fingerprint.equals(existing.get().commandDigest())) throw WorkerException.conflict("WORKER_COMMAND_CONFLICT");
            return status(d,true);
        }
        c=requireOwner(d,cmd.owner(),true); var classification=WorkerFailure.classify(cmd,c.stageCode());
        boolean exhausted=classification.retryable() && d.generation()>=3;
        StageClaim target=new StageClaim(c.stageId(),c.token());
        if("RECONCILIATION".equals(cmd.completedThrough()) && c.stageCode().equals("TRANSCRIPTION")) {
            var metrics=new LinkedHashMap<String,Object>(); metrics.put("speech_coverage_validated",true);
            metrics.put("durationMs",(cmd.metrics().get("sampleCount")*1000+15999)/16000);
            lifecycle.completeStage(target,"SUCCEEDED",null,MAPPER.writeValueAsString(metrics));
            target=lifecycle.startTranscriptionWorkerStage(job,"CONTEXTUAL_CORRECTION");
        }
        lifecycle.failStage(target,classification.code(),null,classification.retryable() && !exhausted);
        repository.failure(d,c,cmd.commandId(),fingerprint,classification.code(),classification.retryable() && !exhausted,exhausted);
        return status(d,false);
    }
}
