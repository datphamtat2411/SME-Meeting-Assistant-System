package com.sme.meetingassistant.api.media.diarization;

import com.sme.meetingassistant.api.diarization.contract.DiarizationResultContract;
import com.sme.meetingassistant.api.diarization.contract.DiarizationResultContract.*;
import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.diarization.DiarizationWorkerRepository.*;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.media.service.ProcessingTranscriptEvidence;
import com.sme.meetingassistant.api.media.service.ProcessingTranscriptEvidence.TimingSnapshot;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import java.math.BigInteger;
import java.util.*;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class DiarizationWorkerService {
    private final DiarizationWorkerRepository repository;
    private final DiarizationWorkerCapability capability;
    private final ProcessingJobLifecycle lifecycle;
    private final ProcessingTranscriptEvidence transcripts;
    private final MediaProperties properties;
    private final ObjectProvider<DiarizationSpeakerProjection> projection;
    public DiarizationWorkerService(DiarizationWorkerRepository repository,DiarizationWorkerCapability capability,
            ProcessingJobLifecycle lifecycle,ProcessingTranscriptEvidence transcripts,MediaProperties properties,
            ObjectProvider<DiarizationSpeakerProjection> projection) {
        this.repository=repository;this.capability=capability;this.lifecycle=lifecycle;this.transcripts=transcripts;
        this.properties=properties;this.projection=projection;
    }
    private Delivery delivery(UUID job,UUID event) {capability.requireAvailable();return repository.delivery(job,event);}
    private Delivery lock(UUID job,UUID event) {
        delivery(job,event);transcripts.lockDiarizationSource(job);repository.lockJob(job);return repository.delivery(job,event);
    }
    private Claim owner(Delivery d,DiarizationCommands.Owner o,boolean live) {
        var c=repository.claim(d.event()).orElseThrow(()->WorkerException.conflict("WORKER_LEASE_LOST"));
        if(!d.stage().equals(o.executionStageRunId()) || !c.stage().equals(o.executionStageRunId()) || !c.token().equals(o.claimToken())
            || live && (!c.live() || repository.receipt(d.event()).isPresent())) throw WorkerException.conflict("WORKER_LEASE_LOST");
        return c;
    }
    private TimingSnapshot timing(Delivery d) {
        var evidence=transcripts.diarizationSource(d.job()).orElseThrow(()->WorkerException.conflict("DIARIZATION_SOURCE_STALE"));
        if(!evidence.current() || !d.transcript().equals(evidence.transcriptId()) || d.revision()!=evidence.contentRevision())
            throw WorkerException.conflict("DIARIZATION_SOURCE_STALE");
        var snapshot=transcripts.diarizationTiming(d.job(),d.meeting(),d.media(),d.transcript(),d.revision(),DiarizationResultContract.MAX_ASSIGNMENTS)
            .orElseThrow(()->WorkerException.conflict("DIARIZATION_SOURCE_STALE"));
        var source=repository.source(d,capability.storageId());
        if(snapshot.durationMs()>source.get("durationMs").longValue()) throw WorkerException.conflict("DIARIZATION_SOURCE_STALE");
        return snapshot;
    }
    private void source(Delivery d,Claim c) {
        var current=repository.source(d,capability.storageId());
        for(String f:List.of("sourceMediaId","sourceRevision","storageId","objectKey","contentType","sha256"))
            if(!current.get(f).asString().equals(c.source().get(f).asString())) throw WorkerException.conflict("DIARIZATION_SOURCE_STALE");
        for(String f:List.of("sizeBytes","durationMs"))
            if(current.get(f).longValue()!=c.source().get(f).longValue()) throw WorkerException.conflict("DIARIZATION_SOURCE_STALE");
    }
    @Transactional
    public Map<String,Object> claim(UUID job,DiarizationCommands.Claim cmd) {
        var d=lock(job,cmd.eventId());
        if(!"PROCESSING_DIARIZATION_REQUESTED".equals(cmd.eventType()) || cmd.eventSchemaVersion()!=1
            || !d.meeting().equals(cmd.meetingId()) || !d.media().equals(cmd.sourceMediaId()) || !d.stage().equals(cmd.executionStageRunId()))
            throw WorkerException.conflict("WORKER_IDENTITY_CONFLICT");
        if(repository.receipt(d.event()).isPresent() || d.attempt()<d.latest()) return status(d);
        timing(d);
        var prior=repository.claim(d.event());
        if(prior.isPresent()) {
            var c=prior.get();
            if(!c.request().equals(cmd.claimRequestId())) throw WorkerException.conflict("WORKER_ATTEMPT_BUSY");
            if(!c.fingerprint().equals(DiarizationCommands.fingerprint(cmd))) throw WorkerException.conflict("WORKER_COMMAND_CONFLICT");
            owner(d,new DiarizationCommands.Owner(d.event(),d.stage(),c.token()),true);source(d,c);
        } else {
            if(!"PENDING".equals(d.stageStatus()) || d.attempt()!=d.latest()) throw WorkerException.conflict("WORKER_ATTEMPT_BUSY");
            var src=repository.source(d,capability.storageId());
            var stage=lifecycle.startStage(job,"DIARIZING",null,null);
            if(!stage.stageRunId().equals(d.stage())) throw WorkerException.conflict("WORKER_IDENTITY_CONFLICT");
            repository.insertClaim(d,cmd,stage.claimToken(),src);
        }
        var c=repository.claim(d.event()).orElseThrow();var data=base(d);
        data.put("eventType","PROCESSING_DIARIZATION_REQUESTED");data.put("eventSchemaVersion",1);
        data.put("meetingId",d.meeting());data.put("executionStageCode","DIARIZING");data.put("claimToken",c.token());
        data.putAll(lease(c));data.put("source",c.source());
        data.put("transcript",Map.of("transcriptId",d.transcript(),"transcriptRevision",d.revision()));
        data.put("resultSlot",Map.of("storageId",c.source().get("storageId").asString(),"objectKey",DiarizationWorkerRepository.resultKey(job,d.stage()),
            "producerStageRunId",d.stage(),"maxBytes",DiarizationResultContract.MAX_RESULT_BYTES,"createOnly",true,"requiredIfNoneMatch","*"));
        return data;
    }
    private Map<String,Object> lease(Claim c) {
        int seconds=properties.getProcessing().getStageLeaseSeconds();
        return Map.of("leaseExpiresAt",c.expires(),"serverTime",repository.now(),"leaseSeconds",seconds,"renewAfterSeconds",Math.max(1,seconds/4));
    }
    @Transactional
    public TimingSnapshot snapshot(UUID job,DiarizationCommands.Owner cmd) {
        var d=lock(job,cmd.eventId());var c=owner(d,cmd,true);source(d,c);return timing(d);
    }
    @Transactional
    public Map<String,Object> renew(UUID job,DiarizationCommands.Owner cmd) {
        var d=lock(job,cmd.eventId());var c=owner(d,cmd,true);
        lifecycle.renewStageLease(new StageClaim(c.stage(),c.token()));var data=new LinkedHashMap<String,Object>(lease(repository.claim(d.event()).orElseThrow()));
        data.put("contractVersion","1.0");return data;
    }
    private void command(UUID id,Object cmd) {
        repository.command(id).ifPresent(prior->{if(!prior.fingerprint().equals(DiarizationCommands.fingerprint(cmd))) throw WorkerException.conflict("WORKER_COMMAND_CONFLICT");});
    }
    private Map<String,Object> acceptedReplay(Delivery d,DiarizationCommands.Complete cmd) {
        command(cmd.commandId(),cmd);var receipt=repository.receipt(d.event());
        if(receipt.isEmpty()) return null;
        owner(d,cmd.owner(),false);var r=receipt.get();
        if(!"RESULT_ACCEPTED".equals(r.state()) || !cmd.commandId().equals(r.command())) throw WorkerException.conflict("WORKER_COMMAND_CONFLICT");
        var v=repository.verification(d.event()).orElseThrow();
        if(!cmd.resultSha256().equals(v.digest()) || !d.stage().equals(cmd.resultProducerStageRunId())) throw WorkerException.conflict("WORKER_RESULT_CONFLICT");
        return status(d);
    }
    /** Short database transaction only. Exact acceptance replay precedes lease/revision checks. */
    @Transactional
    public Map<String,Object> completionReplay(UUID job,DiarizationCommands.Complete cmd) {
        var d=lock(job,cmd.owner().eventId());var accepted=acceptedReplay(d,cmd);if(accepted!=null) return accepted;
        owner(d,cmd.owner(),true);
        var v=repository.verification(d.event());
        if(v.isPresent()) {
            requireVerification(v.get(),cmd);timing(d);source(d,repository.claim(d.event()).orElseThrow());
            if(projection.getIfAvailable()==null) return status(d);
        }
        return null;
    }
    private void requireVerification(Verification v,DiarizationCommands.Complete cmd) {
        if(!v.command().equals(cmd.commandId()) || !v.digest().equals(cmd.resultSha256())) throw WorkerException.conflict("WORKER_RESULT_CONFLICT");
    }
    @Transactional
    public ValidationContext completionContext(UUID job,DiarizationCommands.Complete cmd) {
        var d=lock(job,cmd.owner().eventId());var c=owner(d,cmd.owner(),true);command(cmd.commandId(),cmd);
        if(!d.stage().equals(cmd.resultProducerStageRunId())) throw WorkerException.conflict("WORKER_IDENTITY_CONFLICT");
        repository.verification(d.event()).ifPresent(v->requireVerification(v,cmd));source(d,c);var snapshot=timing(d);
        // Reserve the authenticated command before object I/O; even a lost/invalid verification
        // cannot let this command ID select different bytes on a later delivery.
        if(repository.command(cmd.commandId()).isEmpty()) repository.insertCommand(d,cmd.commandId(),DiarizationCommands.fingerprint(cmd),"COMPLETE");
        return new ValidationContext(job,d.media(),d.sourceRevision(),d.transcript(),BigInteger.valueOf(d.revision()),d.stage(),
            BigInteger.valueOf(snapshot.durationMs()),snapshot.segments().stream().map(s->BigInteger.valueOf(s.ordinal())).toList());
    }
    @Transactional
    public Map<String,Object> registerVerified(UUID job,DiarizationCommands.Complete cmd,int size) {
        var d=lock(job,cmd.owner().eventId());var replay=acceptedReplay(d,cmd);if(replay!=null) return replay;
        completionContext(job,cmd);var existing=repository.verification(d.event());
        if(existing.isEmpty()) repository.verify(d,repository.claim(d.event()).orElseThrow(),cmd,size);
        return status(d);
    }
    /** SPK-10's sole integration boundary: projection, acceptance, success and job transition are atomic. */
    @Transactional
    public Map<String,Object> projectVerified(UUID job,DiarizationCommands.Complete cmd,ValidatedResult result) {
        var d=lock(job,cmd.owner().eventId());var replay=acceptedReplay(d,cmd);if(replay!=null) return replay;
        var context=completionContext(job,cmd);var v=repository.verification(d.event()).orElseThrow();requireVerification(v,cmd);
        if(!result.processingJobId().equals(context.processingJobId()) || !result.sourceMediaId().equals(context.sourceMediaId())
            || !result.sourceRevision().equals(context.sourceRevision()) || !result.transcriptId().equals(context.transcriptId())
            || !result.transcriptRevision().equals(context.transcriptRevision()) || !result.producerStageRunId().equals(context.producerStageRunId()))
            throw WorkerException.conflict("WORKER_RESULT_CONFLICT");
        var operation=projection.getIfAvailable();if(operation==null) return status(d);
        operation.project(result);
        // Projection exceptions roll back every mutation below; verification committed independently.
        repository.accept(d,cmd,v);
        lifecycle.completeStage(new StageClaim(d.stage(),cmd.owner().claimToken()),"SUCCEEDED",null,null);
        if(!lifecycle.hasPendingPipelineStages(job)) lifecycle.completeJob(job);
        return status(d);
    }
    @Transactional
    public Map<String,Object> fail(UUID job,DiarizationCommands.Fail cmd) {
        var d=lock(job,cmd.owner().eventId());owner(d,cmd.owner(),false);command(cmd.commandId(),cmd);
        var receipt=repository.receipt(d.event());
        if(receipt.isPresent()) {
            if(!"FAILURE_RECORDED".equals(receipt.get().state()) || !cmd.commandId().equals(receipt.get().command())) throw WorkerException.conflict("WORKER_COMMAND_CONFLICT");
            return status(d);
        }
        var c=owner(d,cmd.owner(),true);
        boolean retryable=cmd.retryable() && d.attempt()<=properties.getProcessing().getMaxRetries();
        lifecycle.failStage(new StageClaim(c.stage(),c.token()),"DIARIZATION_FAILED",null,retryable);
        repository.failure(d,cmd,retryable);return status(d);
    }
    @Transactional(readOnly=true,isolation=org.springframework.transaction.annotation.Isolation.REPEATABLE_READ)
    public Map<String,Object> status(UUID job,UUID event) {return status(delivery(job,event));}
    private LinkedHashMap<String,Object> base(Delivery d) {
        var data=new LinkedHashMap<String,Object>();data.put("contractVersion","1.0");data.put("processingJobId",d.job());
        data.put("eventId",d.event());data.put("executionStageRunId",d.stage());return data;
    }
    private Map<String,Object> status(Delivery d) {
        var data=base(d);var r=repository.receipt(d.event());var v=repository.verification(d.event());String state;
        if(r.isPresent()) {
            var receipt=r.get();state=receipt.state();var metadata=new LinkedHashMap<String,Object>();metadata.put("receiptId",receipt.id());metadata.put("recordedAt",receipt.recordedAt());
            if("RESULT_ACCEPTED".equals(state)) {metadata.put("verificationId",receipt.verification());metadata.put("resultSha256",v.orElseThrow().digest());}
            else {metadata.put("errorCode",receipt.error());metadata.put("retryable",receipt.retryable());}
            data.put("receipt",metadata);
        } else if(d.attempt()<d.latest()) {state="SUPERSEDED";data.put("receipt",Map.of("supersedingAttemptNumber",d.latest()));}
        else if(v.isPresent()) {state="RESULT_VERIFIED";data.put("verification",Map.of("verificationId",v.get().id(),"resultSha256",v.get().digest(),"verifiedAt",v.get().verifiedAt()));}
        else {
            var c=repository.claim(d.event());
            state=c.isPresent()?(c.get().live()?"RUNNING":"AWAITING_RECONCILIATION"):
                ("PENDING".equals(d.stageStatus()) && "RUNNING".equals(d.jobStatus())?"AVAILABLE":"AWAITING_RECONCILIATION");
        }
        data.put("state",state);data.put("acknowledge",Set.of("RESULT_ACCEPTED","FAILURE_RECORDED","SUPERSEDED").contains(state));return data;
    }
}
