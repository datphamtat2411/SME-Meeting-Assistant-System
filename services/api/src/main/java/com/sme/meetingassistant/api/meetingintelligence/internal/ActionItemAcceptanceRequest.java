package com.sme.meetingassistant.api.meetingintelligence.internal;

import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink.Candidate;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import com.sme.meetingassistant.api.meetingintelligence.service.ActionItemProposalHandoff.SourceReference;
import java.time.LocalDate;
import java.util.*;
import tools.jackson.databind.JsonNode;

/** Exact, versioned machine DTO. No business authority or storage location fields. */
public record ActionItemAcceptanceRequest(UUID eventId,StageClaim claim,SourceReference source,List<Candidate> candidates) {
    public static ActionItemAcceptanceRequest parse(JsonNode input) {
        WorkerJson.fields(input,"contractVersion","eventId","stageRunId","claimToken","source","candidates");
        WorkerJson.choice(input,"contractVersion","1.0");
        UUID event=WorkerJson.uuid(input,"eventId");
        var claim=new StageClaim(WorkerJson.uuid(input,"stageRunId"),WorkerJson.uuid(input,"claimToken"));
        var pinned=input.get("source");
        WorkerJson.fields(pinned,"snapshotId","transcriptId","contentRevision","sha256");
        var source=new SourceReference(WorkerJson.uuid(pinned,"snapshotId"),WorkerJson.uuid(pinned,"transcriptId"),
            WorkerJson.number(pinned,"contentRevision",0,Long.MAX_VALUE),WorkerJson.digest(pinned,"sha256"));
        List<Candidate> candidates=new ArrayList<>();Set<String> keys=new HashSet<>();
        for(var item:WorkerJson.array(input,"candidates",0,200)) {
            WorkerJson.fields(item,"candidateKey","title","details","suggestedDueDate","evidenceSegmentIds");
            String key=WorkerJson.string(item,"candidateKey",128);
            WorkerJson.require(key.matches("[A-Za-z0-9._-]{1,128}") && keys.add(key));
            String title=WorkerJson.string(item,"title",500);
            WorkerJson.require(title.codePoints().noneMatch(Character::isISOControl));
            String details=item.get("details").isNull()?null:WorkerJson.string(item,"details",10000);
            if(details!=null) {
                for(int i=0;i<details.length();i++) {
                    if(details.charAt(i)=='\r') WorkerJson.require(i+1<details.length() && details.charAt(++i)=='\n');
                }
            }
            LocalDate due=null;
            if(!item.get("suggestedDueDate").isNull()) {
                String date=WorkerJson.string(item,"suggestedDueDate",10);
                WorkerJson.require(date.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}"));
                try {due=LocalDate.parse(date);WorkerJson.require(due.getYear()>=1);}
                catch(java.time.DateTimeException invalid) {WorkerJson.require(false);}
            }
            List<UUID> evidence=new ArrayList<>();
            for(var id:WorkerJson.array(item,"evidenceSegmentIds",1,50)) {
                var wrapper=WorkerJson.MAPPER.createObjectNode();wrapper.set("id",id);
                evidence.add(WorkerJson.uuid(wrapper,"id"));
            }
            WorkerJson.require(new HashSet<>(evidence).size()==evidence.size());
            candidates.add(new Candidate(key,title,details,due,evidence));
        }
        return new ActionItemAcceptanceRequest(event,claim,source,List.copyOf(candidates));
    }
}
