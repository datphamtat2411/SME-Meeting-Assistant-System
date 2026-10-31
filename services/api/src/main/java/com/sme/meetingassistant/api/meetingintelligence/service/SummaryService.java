package com.sme.meetingassistant.api.meetingintelligence.service;

import com.sme.meetingassistant.api.meeting.service.MeetingIntelligenceAccess;
import com.sme.meetingassistant.api.meetingintelligence.dto.EditSummaryRequest;
import com.sme.meetingassistant.api.meetingintelligence.dto.SummaryView;
import com.sme.meetingassistant.api.meetingintelligence.repository.SummaryRepository;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class SummaryService {
    private final SummaryRepository repository;
    private final MeetingIntelligenceAccess access;
    private final AuthenticatedUserId identity;
    private final MeetingIntelligenceAudit audit;

    public SummaryService(SummaryRepository repository, MeetingIntelligenceAccess access,
            AuthenticatedUserId identity, MeetingIntelligenceAudit audit) {
        this.repository = repository;
        this.access = access;
        this.identity = identity;
        this.audit = audit;
    }

    @Transactional(readOnly = true)
    public SummaryView current(UUID meetingId) {
        UUID actor = identity.requireUserId();
        access.requireIntelligenceReadable(meetingId, actor);
        return repository.current(meetingId).orElseThrow(SummaryService::missing);
    }

    @Transactional
    public SummaryView edit(UUID meetingId, String ifMatch, EditSummaryRequest request) {
        UUID actor = identity.requireUserId();
        access.requireSummaryEditAllowed(meetingId, actor);
        if (request == null || request.content() == null ||
                request.content().isBlank() || request.content().length() > 20_000) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
        }

        // The meeting row is the shared serialization point for current Summary
        // changes and transcript corrections. Every other Summary publisher must
        // follow the same meeting-first lock policy.
        repository.lockMeeting(meetingId);
        SummaryView previous = repository.current(meetingId).orElseThrow(SummaryService::missing);
        IntelligenceVersionTags.requireSummaryMatch(previous.id(), previous.versionNumber(), previous.isStale(), ifMatch);

        // A no-op does not fabricate a new human revision or rotate its ETag.
        if (previous.content().equals(request.content())) {
            return previous;
        }
        repository.replaceCurrentWithHumanEdit(meetingId, previous, UUID.randomUUID(),
            actor, request.content());
        var updated = repository.current(meetingId).orElseThrow(SummaryService::missing);
        audit.summaryEdited(actor, meetingId, previous.id(), updated.id(),
            previous.versionNumber(), updated.versionNumber(), updated.isStale());
        return updated;
    }

    private static ResponseStatusException missing() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND);
    }
}
