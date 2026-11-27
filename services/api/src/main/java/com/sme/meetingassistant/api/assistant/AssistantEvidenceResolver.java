package com.sme.meetingassistant.api.assistant;

import com.sme.meetingassistant.api.actionitems.ActionItemService;
import com.sme.meetingassistant.api.assistant.AssistantModels.*;
import com.sme.meetingassistant.api.meeting.service.MeetingCoreService;
import com.sme.meetingassistant.api.meetingintelligence.service.DecisionService;
import com.sme.meetingassistant.api.meetingintelligence.service.SummaryService;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

/** Resolves only persisted citations through canonical source readers. */
@Component
final class AssistantEvidenceResolver {
    private final AssistantSourceVerifier sources;
    private final MeetingCoreService meetings;
    private final SummaryService summaries;
    private final DecisionService decisions;
    private final ActionItemService actionItems;

    AssistantEvidenceResolver(AssistantSourceVerifier sources, MeetingCoreService meetings,
            SummaryService summaries, DecisionService decisions, ActionItemService actionItems) {
        this.sources=sources;
        this.meetings=meetings;
        this.summaries=summaries;
        this.decisions=decisions;
        this.actionItems=actionItems;
    }

    List<EvidenceView> resolve(UUID meeting,UUID actor,List<CitationView> citations) {
        if(citations.isEmpty())return List.of();
        String meetingTitle=meetings.detail(meeting).getTitle();
        Map<SourceKey,Display> resolved=new HashMap<>();
        List<EvidenceView> result=new ArrayList<>(citations.size());
        for(CitationView citation:citations){
            if(!meeting.equals(citation.meetingId()))throw stale();
            var key=new SourceKey(citation.sourceType(),citation.sourceId(),citation.sourceRevision());
            Display display=resolved.computeIfAbsent(key,source->resolveSource(meeting,actor,source));
            result.add(new EvidenceView(citation.citationId(),citation.sourceType(),citation.sourceId(),
                citation.sourceRevision(),display.label(),meetingTitle,display.preview(),citation.claimIds(),
                new EvidenceNavigation(display.target(),"SOURCE")));
        }
        // Recheck every distinct source after the projection reads. A concurrent
        // revision or eligibility change must invalidate the entire answer.
        for(SourceKey key:resolved.keySet())requireCurrent(meeting,key);
        return List.copyOf(result);
    }

    private Display resolveSource(UUID meeting,UUID actor,SourceKey key) {
        requireCurrent(meeting,key);
        try {
            return switch(key.type()){
                // Canonical citation does not retain exact segment provenance.
                case "TRANSCRIPT" -> new Display("Transcript",null,"MEETING_TRANSCRIPT");
                case "SUMMARY" -> {
                    var summary=summaries.current(meeting);
                    if(!key.id().equals(summary.id())||key.revision()!=summary.versionNumber()
                            ||summary.isStale())throw stale();
                    yield new Display("Meeting summary",preview(summary.content()),"MEETING_SUMMARY");
                }
                case "DECISION" -> {
                    var decision=decisions.detail(meeting,key.id());
                    if(key.revision()!=decision.version()||decision.isStale()
                            ||!"CONFIRMED".equals(decision.status()))throw stale();
                    yield new Display("Confirmed decision",preview(decision.content()),"MEETING_DECISIONS");
                }
                case "ACTION_ITEM" -> {
                    var item=actionItems.detail(key.id(),actor);
                    if(!meeting.equals(item.meetingId())||key.revision()!=item.version()
                            ||!item.isOfficial()||!item.capabilities().canAccessMeeting())throw stale();
                    String text=item.title();
                    if(item.details()!=null&&!item.details().isBlank())text+="\n"+item.details();
                    yield new Display("Official action item",preview(text),"MEETING_ACTION_ITEMS");
                }
                default -> throw stale();
            };
        } catch(ResponseStatusException failure){
            // A missing/denied artifact must not leak an old evidence projection.
            // Preserve infrastructure errors and session failures.
            if(failure.getStatusCode().value()==404||failure.getStatusCode().value()==403){
                meetings.requireReadable(meeting,actor);
                throw stale();
            }
            throw failure;
        }
    }

    private void requireCurrent(UUID meeting,SourceKey key){
        if(!sources.current(key.type(),key.id(),meeting,key.revision()))throw stale();
    }

    static AssistantDomainException stale(){
        return new AssistantDomainException(HttpStatus.CONFLICT,"ASSISTANT_SOURCE_STALE",
            "Assistant evidence is no longer current.");
    }

    private static String preview(String content){
        if(content==null||content.isBlank())return null;
        int length=content.codePointCount(0,content.length());
        return content.substring(0,content.offsetByCodePoints(0,Math.min(500,length)));
    }

    private record SourceKey(String type,UUID id,long revision){}
    private record Display(String label,String preview,String target){}
}
