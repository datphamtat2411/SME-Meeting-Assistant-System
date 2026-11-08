package com.sme.meetingassistant.api.meetingintelligence.service;

import com.sme.meetingassistant.api.meeting.service.MeetingIntelligenceAccess;
import com.sme.meetingassistant.api.meetingintelligence.dto.DecisionView;
import com.sme.meetingassistant.api.meetingintelligence.repository.DecisionRepository;
import com.sme.meetingassistant.api.meetingintelligence.repository.SummaryRepository;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/**
 * No cross-feature repository lookup by the Minutes assembler: canonical
 * current version and confirmed Decision evidence stay owned by MI.
 */
@Service
public class IntelligenceMinutesReader implements IntelligenceMinutesSource {
    private static final int PAGE_SIZE = 100;
    private static final int MAX_DECISIONS = 2000;
    private final SummaryRepository summaries;
    private final DecisionRepository decisions;
    private final MeetingIntelligenceAccess access;
    private final AuthenticatedUserId principal;

    public IntelligenceMinutesReader(SummaryRepository summaries, DecisionRepository decisions,
            MeetingIntelligenceAccess access, AuthenticatedUserId principal) {
        this.summaries = summaries;
        this.decisions = decisions;
        this.access = access;
        this.principal = principal;
    }

    @Override
    @Transactional(readOnly = true)
    public CurrentMinutesIntelligence currentApproved(UUID meetingId) {
        access.requireIntelligenceReadable(meetingId, principal.requireUserId());
        var summary = summaries.current(meetingId);
        List<DecisionView> confirmed = new ArrayList<>();
        for (int page = 0; page <= MAX_DECISIONS / PAGE_SIZE; page++) {
            var batch = decisions.page(meetingId, "CONFIRMED", page, PAGE_SIZE);
            if (batch.getTotalElements() > MAX_DECISIONS) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                        "Minutes decision count exceeds safe export limit");
            }
            confirmed.addAll(batch.getContent());
            if (!batch.hasNext()) break;
        }
        return new CurrentMinutesIntelligence(summary, confirmed);
    }
}
