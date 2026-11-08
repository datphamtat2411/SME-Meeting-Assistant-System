package com.sme.meetingassistant.api.media.intelligence;

import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.intelligence.IntelligenceWorkerRepository.*;
import com.sme.meetingassistant.api.media.service.*;
import com.sme.meetingassistant.api.media.service.ProcessingIntelligenceSource.Snapshot;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import java.util.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.*;

/** Short database-only commands. Source I/O belongs to the nontransactional facade. */
@Service
public class IntelligenceWorkerTransactions {
    private final IntelligenceWorkerRepository repository;
    private final IntelligenceWorkerCapability capability;
    private final ProcessingJobLifecycle lifecycle;
    private final ProcessingTranscriptEvidence transcripts;
    private final ProcessingDerivedSnapshotEvidence evidence;
    private final ProcessingIntelligenceSource sources;
    private final MediaProperties properties;
    public IntelligenceWorkerTransactions(IntelligenceWorkerRepository repository,IntelligenceWorkerCapability capability,
            ProcessingJobLifecycle lifecycle,ProcessingTranscriptEvidence transcripts,ProcessingDerivedSnapshotEvidence evidence,
            ProcessingIntelligenceSource sources,MediaProperties properties) {
        this.repository=repository;this.capability=capability;this.lifecycle=lifecycle;this.transcripts=transcripts;
        this.evidence=evidence;this.sources=sources;this.properties=properties;
    }
    private Delivery lock(UUID job,UUID event) {
        repository.delivery(job,event);transcripts.lockDiarizationSource(job);repository.lockJob(job);return repository.delivery(job,event);
    }
    public record Preparation(Delivery delivery,Map<String,Object> terminal) {}
    @Transactional
    public Preparation preflight(UUID job,IntelligenceCommands.Claim command,String peer) {
        var d=lock(job,command.eventId());
        if(!"PROCESSING_INTELLIGENCE_STAGE_REQUESTED".equals(command.eventType()) || command.eventSchemaVersion()!=d.schema()
            || !d.stage().equals(command.executionStageRunId()) || !d.code().equals(command.executionStageCode()))
            throw WorkerException.conflict("WORKER_IDENTITY_CONFLICT");
        var status=status(d);
        if(Boolean.TRUE.equals(status.get("acknowledge"))) return new Preparation(d,status);
        capability.requireStage(d.code());
        if(!"AVAILABLE".equals(d.mediaStatus())) throw WorkerException.conflict("WORKER_SOURCE_INELIGIBLE");
        var prior=repository.claim(d.event());
        if(prior.isPresent()) {
            var c=prior.get();
            if(!c.peer().equals(peer) || !c.request().equals(command.claimRequestId())) throw WorkerException.conflict("WORKER_ATTEMPT_BUSY");
            if(!c.fingerprint().equals(IntelligenceCommands.fingerprint(command))) throw WorkerException.conflict("WORKER_COMMAND_CONFLICT");
            if(!d.live()) throw WorkerException.conflict("WORKER_LEASE_LOST");
        } else if(!"PENDING".equals(d.status()) || !lifecycle.intelligenceStageEligible(job,d.stage(),d.code())
                || "FAILED".equals(d.publication())) throw WorkerException.conflict("WORKER_ATTEMPT_BUSY");
        return new Preparation(d,null);
    }
    @Transactional
    public Map<String,Object> claim(UUID job,IntelligenceCommands.Claim command,String peer,Snapshot source) {
        var prepared=preflight(job,command,peer);
        if(prepared.terminal()!=null) return prepared.terminal();
        var d=prepared.delivery();
        sources.requireBinding(job,d.meeting(),d.media(),d.derived(),source);
        var prior=repository.claim(d.event());
        if(prior.isPresent()) {
            if(!prior.get().snapshot().equals(source.snapshotId())) throw WorkerException.conflict("INTELLIGENCE_SOURCE_INVALID");
        } else {
            var claim=lifecycle.startIntelligenceWorkerStage(job,d.stage(),d.code());
            if(!claim.stageRunId().equals(d.stage())) throw WorkerException.conflict("WORKER_IDENTITY_CONFLICT");
            repository.insertClaim(d,command,peer,source.snapshotId());
        }
        d=repository.delivery(job,d.event());
        var response=base(d);response.put("eventType","PROCESSING_INTELLIGENCE_STAGE_REQUESTED");response.put("eventSchemaVersion",d.schema());
        response.put("meetingId",d.meeting());response.put("sourceMediaId",d.media());response.put("claimToken",d.token());response.putAll(lease(d));
        response.put("source",Map.of("snapshotId",source.snapshotId(),"storageId",capability.storageId(),"objectKey",source.objectKey(),
            "sha256",source.sha256(),"sizeBytes",source.sizeBytes(),"transcriptId",source.transcriptId(),"contentRevision",source.contentRevision(),"schemaVersion",1));
        if(!"EXTRACTING_ACTION_ITEMS".equals(d.code())) response.put("resultSlot",Map.of("storageId",capability.storageId(),
            "objectKey","processing/"+job+"/intelligence/results/"+d.stage()+".json","producerStageRunId",d.stage(),
            "maxBytes",4*1024*1024,"createOnly",true,"requiredIfNoneMatch","*"));
        IntelligenceOperationLog.record("CLAIMED",job,d.stage(),d.event());return response;
    }
    private Map<String,Object> lease(Delivery d) {
        int seconds=properties.getProcessing().getStageLeaseSeconds();
        return Map.of("leaseExpiresAt",d.expires(),"serverTime",repository.now(),"leaseSeconds",seconds,"renewAfterSeconds",Math.max(1,seconds/4));
    }
    private Claim owner(Delivery d,IntelligenceCommands.Owner command,String peer,boolean live) {
        var c=repository.claim(d.event()).orElseThrow(()->WorkerException.conflict("WORKER_LEASE_LOST"));
        if(!c.peer().equals(peer) || !d.stage().equals(command.executionStageRunId()) || d.token()==null || !d.token().equals(command.claimToken())
            || live && (!d.live() || !"AVAILABLE".equals(d.mediaStatus()))) throw WorkerException.conflict("WORKER_LEASE_LOST");
        return c;
    }
    @Transactional
    public Map<String,Object> renew(UUID job,IntelligenceCommands.Owner command,String peer) {
        var d=lock(job,command.eventId());capability.requireStage(d.code());owner(d,command,peer,true);
        lifecycle.renewStageLease(new StageClaim(d.stage(),command.claimToken()));
        var response=base(d);response.putAll(lease(repository.delivery(job,d.event())));
        IntelligenceOperationLog.record("RENEWED",job,d.stage(),d.event());return response;
    }
    @Transactional
    public Map<String,Object> fail(UUID job,IntelligenceCommands.Fail command,String peer) {
        var d=lock(job,command.owner().eventId());var c=owner(d,command.owner(),peer,false);
        if(c.failureCommand()!=null) {
            if(!c.failureCommand().equals(command.commandId()) || !c.failureFingerprint().equals(IntelligenceCommands.fingerprint(command)))
                throw WorkerException.conflict("WORKER_COMMAND_CONFLICT");
            return status(d);
        }
        capability.requireStage(d.code());owner(d,command.owner(),peer,true);
        boolean retryable=command.retryable() && d.attempt()<=properties.getProcessing().getMaxRetries();
        lifecycle.failStage(new StageClaim(d.stage(),command.owner().claimToken()),"INTELLIGENCE_"+command.category(),null,retryable);
        repository.recordFailure(d.event(),command);IntelligenceOperationLog.record("FAILED",job,d.stage(),d.event());
        return status(repository.delivery(job,d.event()));
    }
    @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    public Map<String,Object> status(UUID job,UUID event) {return status(repository.delivery(job,event));}
    private LinkedHashMap<String,Object> base(Delivery d) {
        var data=new LinkedHashMap<String,Object>();data.put("contractVersion","1.0");data.put("processingJobId",d.job());data.put("eventId",d.event());
        data.put("executionStageRunId",d.stage());data.put("executionStageCode",d.code());return data;
    }
    private Map<String,Object> status(Delivery d) {
        String state;
        if(d.attempt()<d.latest()) state="SUPERSEDED";
        else if(List.of("SUCCEEDED","SUCCEEDED_WITH_WARNING").contains(d.status())
            && evidence.hasAcceptedResultForStage(d.job(),d.stage(),d.code())) state="RESULT_ACCEPTED";
        else if("FAILED".equals(d.status())) state="FAILURE_RECORDED";
        else if(d.live()) state="RUNNING";
        else if("PENDING".equals(d.status()) && !"FAILED".equals(d.publication())
            && lifecycle.intelligenceStageEligible(d.job(),d.stage(),d.code())) state="AVAILABLE";
        else state="AWAITING_RECONCILIATION";
        var data=base(d);data.put("state",state);data.put("acknowledge",Set.of("SUPERSEDED","RESULT_ACCEPTED","FAILURE_RECORDED").contains(state));
        if("FAILURE_RECORDED".equals(state)) {data.put("errorCode",Objects.toString(d.error(),"INTELLIGENCE_FAILED"));data.put("retryable",d.retryable());}
        return data;
    }
}
