package com.sme.meetingassistant.api.meetingintelligence.service;

import com.sme.meetingassistant.api.meetingintelligence.dto.DecisionView;
import com.sme.meetingassistant.api.meetingintelligence.dto.SummaryView;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Meeting Intelligence-owned read port: current Summary and confirmed Decisions only. */
public interface IntelligenceMinutesSource {
    CurrentMinutesIntelligence currentApproved(UUID meetingId);

    record CurrentMinutesIntelligence(Optional<SummaryView> summary,
            List<DecisionView> confirmedDecisions) {
        public CurrentMinutesIntelligence {
            summary = summary == null ? Optional.empty() : summary;
            confirmedDecisions = List.copyOf(confirmedDecisions);
        }
    }
}
