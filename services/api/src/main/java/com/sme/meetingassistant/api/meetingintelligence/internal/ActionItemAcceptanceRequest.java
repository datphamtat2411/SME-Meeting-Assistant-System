package com.sme.meetingassistant.api.meetingintelligence.internal;

import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink.Candidate;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import com.sme.meetingassistant.api.meetingintelligence.service.ActionItemProposalHandoff.SourceReference;
import com.sme.meetingassistant.api.meetingintelligence.service.AiQualityMetadata;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceResultPayload;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceResultPayload.GroundingDiagnostic;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceResultPayload.GroundingDiagnosticCounts;
import java.time.LocalDate;
import java.util.*;
import tools.jackson.databind.JsonNode;

/** Exact, versioned machine DTO. No business authority or storage location fields. */
public record ActionItemAcceptanceRequest(UUID eventId,StageClaim claim,SourceReference source,
        List<Candidate> candidates, boolean groundingWarning, String groundingWarningCode,
        List<GroundingDiagnostic> diagnostics, String diagnosticsVersion,
        GroundingDiagnosticCounts diagnosticCounts) {
    public static ActionItemAcceptanceRequest parse(JsonNode input) {
        boolean hasWarning = input != null && input.has("groundingWarning");
        boolean hasDiagnostics = input != null && input.has("diagnostics");
        boolean hasDiagnosticMetadata = input != null
            && (input.has("diagnosticsVersion") || input.has("diagnosticCounts"));
        List<String> fields = new ArrayList<>(List.of(
            "contractVersion","eventId","stageRunId","claimToken","source","candidates"));
        if (hasWarning) fields.add("groundingWarning");
        if (hasDiagnostics) fields.add("diagnostics");
        if (hasDiagnosticMetadata) {
            fields.add("diagnosticsVersion");
            fields.add("diagnosticCounts");
        }
        WorkerJson.fields(input,fields.toArray(String[]::new));
        String warningCode = null;
        if (hasWarning) {
            warningCode = WorkerJson.choice(input,"groundingWarning",
                AiQualityMetadata.CLAIM_DISCARDED,AiQualityMetadata.CLAIM_REPAIRED);
        }
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
        List<GroundingDiagnostic> diagnostics = hasDiagnostics
            ? IntelligenceResultPayload.parseDiagnostics(input.get("diagnostics")) : List.of();
        String diagnosticsVersion = null;
        GroundingDiagnosticCounts diagnosticCounts = null;
        WorkerJson.require(
            diagnostics.stream().noneMatch(diagnostic -> diagnostic.diagnosticVersion() != null)
                || hasDiagnosticMetadata);
        if (hasDiagnosticMetadata) {
            WorkerJson.choice(input,"diagnosticsVersion","1.0");
            var counts = input.get("diagnosticCounts");
            WorkerJson.fields(counts,"version","accepted","rejected","discarded","repaired","total");
            WorkerJson.choice(counts,"version","1.0");
            int accepted = (int)WorkerJson.number(counts,"accepted",0,32);
            int rejected = (int)WorkerJson.number(counts,"rejected",0,32);
            int discarded = (int)WorkerJson.number(counts,"discarded",0,32);
            int repaired = (int)WorkerJson.number(counts,"repaired",0,32);
            int total = (int)WorkerJson.number(counts,"total",0,32);
            WorkerJson.require(total == accepted + rejected + discarded + repaired);
            WorkerJson.require(diagnostics.size() == total);
            WorkerJson.require(diagnostics.stream().filter(d -> "ACCEPTED".equals(d.disposition())).count()
                == accepted);
            WorkerJson.require(diagnostics.stream().filter(d -> "REJECTED".equals(d.disposition())).count()
                == rejected);
            WorkerJson.require(diagnostics.stream().filter(d -> "DISCARDED".equals(d.disposition())).count()
                == discarded);
            WorkerJson.require(diagnostics.stream().filter(d -> "REPAIRED".equals(d.disposition())).count()
                == repaired);
            diagnosticsVersion = "1.0";
            diagnosticCounts = new GroundingDiagnosticCounts(
                diagnosticsVersion,accepted,rejected,discarded,repaired,total);
        }
        return new ActionItemAcceptanceRequest(event,claim,source,List.copyOf(candidates),
            hasWarning,warningCode,List.copyOf(diagnostics),diagnosticsVersion,diagnosticCounts);
    }
}
