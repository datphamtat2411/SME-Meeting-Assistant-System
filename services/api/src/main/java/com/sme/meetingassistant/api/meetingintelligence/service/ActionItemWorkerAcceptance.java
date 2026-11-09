package com.sme.meetingassistant.api.meetingintelligence.service;

import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink;
import com.sme.meetingassistant.api.media.intelligence.IntelligenceWorkerService;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Transport-to-owner adapter only. All canonical writes stay in the existing handoff/sink. */
@Service
public class ActionItemWorkerAcceptance {
    private final IntelligenceWorkerService worker;
    private final ActionItemProposalHandoff handoff;
    public ActionItemWorkerAcceptance(IntelligenceWorkerService worker,ActionItemProposalHandoff handoff) {
        this.worker=worker;this.handoff=handoff;
    }
    @Transactional
    public ActionItemProposalSink.Receipt accept(UUID event,StageClaim claim,
            ActionItemProposalHandoff.SourceReference source,List<ActionItemProposalSink.Candidate> candidates,String peer) {
        worker.requireActionItemOwner(event,claim,source.snapshotId(),peer);
        return handoff.handoff(claim,source,candidates);
    }
}
