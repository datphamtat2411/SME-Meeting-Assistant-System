package com.sme.meetingassistant.api.meetingintelligence.service;

import com.sme.meetingassistant.api.meeting.service.MeetingIntelligenceAccess;
import com.sme.meetingassistant.api.meetingintelligence.dto.CreateDecisionRequest;
import com.sme.meetingassistant.api.meetingintelligence.dto.DecisionView;
import com.sme.meetingassistant.api.meetingintelligence.dto.EditDecisionRequest;
import com.sme.meetingassistant.api.meetingintelligence.repository.DecisionRepository;
import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository.TranscriptSource;
import com.sme.meetingassistant.api.transcript.service.TranscriptSourceGuard;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * MI-05: authorized manual Decision creation, listing and controlled edits.
 * MI-06 extends this service with explicit human confirm/reject transitions.
 */
@Service
public class DecisionService {
    private static final Set<String> STATUSES = Set.of("PROPOSED", "CONFIRMED", "REJECTED");
    private final DecisionRepository decisions;
    private final MeetingIntelligenceAccess access;
    private final AuthenticatedUserId identity;
    private final TranscriptSourceGuard transcripts;

    public DecisionService(DecisionRepository decisions, MeetingIntelligenceAccess access,
            AuthenticatedUserId identity, TranscriptSourceGuard transcripts) {
        this.decisions = decisions;
        this.access = access;
        this.identity = identity;
        this.transcripts = transcripts;
    }

    @Transactional(readOnly = true)
    public Page<DecisionView> list(UUID meetingId, String status, int page, int size) {
        access.requireIntelligenceReadable(meetingId, identity.requireUserId());
        if (page < 0 || page > 100_000 || size < 1 || size > 100 ||
                (status != null && !STATUSES.contains(status))) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
        }
        return decisions.page(meetingId, status, page, size);
    }

    @Transactional
    public DecisionView create(UUID meetingId, CreateDecisionRequest request) {
        UUID actor = identity.requireUserId();
        access.requireDecisionEditAllowed(meetingId, actor);
        if (request == null) throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
        validateContent(request.content(), 5_000);
        List<UUID> evidence = request.evidenceSegmentIds() == null
            ? List.of() : request.evidenceSegmentIds();
        if (evidence.size() > 50 || evidence.stream().anyMatch(x -> x == null)
                || new HashSet<>(evidence).size() != evidence.size()) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                "Decision evidence contains invalid or repeated segment IDs.");
        }

        // Serialize current-transcript source checks with Transcript Review and
        // official Decision writes. MI-03 permissions are never inferred from body fields.
        decisions.lockMeeting(meetingId);
        TranscriptSource source = evidence.isEmpty()
            ? null : transcripts.requireCurrentEvidence(meetingId, evidence);
        UUID decisionId = UUID.randomUUID();
        decisions.createConfirmed(decisionId, meetingId, actor, request.content(),
            source == null ? null : source.transcriptId(),
            source == null ? null : source.contentRevision(), evidence);
        return decisions.find(meetingId, decisionId).orElseThrow(DecisionService::missing);
    }

    @Transactional
    public DecisionView edit(UUID meetingId, UUID decisionId, String ifMatch,
            EditDecisionRequest request) {
        UUID actor = identity.requireUserId();
        access.requireDecisionEditAllowed(meetingId, actor);
        if (request == null) throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
        validateContent(request.content(), 5_000);
        decisions.lockMeeting(meetingId);
        DecisionView current = decisions.find(meetingId, decisionId)
            .orElseThrow(DecisionService::missing);
        IntelligenceVersionTags.requireDecisionMatch(current.id(), current.version(), ifMatch);
        // This task implements the canonical human correction of confirmed
        // Decisions. MI-06 owns review transitions of AI proposals.
        if (!"CONFIRMED".equals(current.status())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "Only confirmed decisions can be corrected.");
        }
        if (current.content().equals(request.content())) return current;

        if (!decisions.updateConfirmedContent(meetingId, current, request.content(), actor)) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
        }
        return decisions.find(meetingId, decisionId).orElseThrow(DecisionService::missing);
    }

    /**
     * MI-06: one authoritative human review transition. Lock the parent
     * meeting first, re-read the Decision, then fence with its current ETag.
     * No LLM result or client-supplied actor/status can perform this action.
     */
    @Transactional
    public DecisionView confirm(UUID meetingId, UUID decisionId, String ifMatch) {
        return review(meetingId, decisionId, ifMatch, true);
    }

    @Transactional
    public DecisionView reject(UUID meetingId, UUID decisionId, String ifMatch) {
        return review(meetingId, decisionId, ifMatch, false);
    }

    private DecisionView review(UUID meetingId, UUID decisionId, String ifMatch, boolean confirm) {
        UUID actor = identity.requireUserId();
        access.requireDecisionReviewAllowed(meetingId, actor);
        decisions.lockMeeting(meetingId);
        DecisionView existing = decisions.find(meetingId, decisionId)
            .orElseThrow(DecisionService::missing);
        IntelligenceVersionTags.requireDecisionMatch(existing.id(), existing.version(), ifMatch);
        if (!"PROPOSED".equals(existing.status())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "Only proposed decisions can be confirmed or rejected.");
        }

        if (confirm) {
            // Review is a human action, but unsafe AI evidence must not become
            // official implicitly. A reviewer may reject the AI proposal and
            // create a separate verified manual Decision when warranted.
            if (existing.transcriptId() != null) {
                transcripts.requireReviewableDecisionEvidence(meetingId,
                    existing.transcriptId(), existing.contentRevision(),
                    existing.evidenceSegmentIds());
            } else if ("AI_EXTRACTED".equals(existing.sourceType())) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "AI-extracted decisions require reviewable transcript evidence.");
            }
        }
        if (!decisions.reviewProposal(meetingId, decisionId, existing.version(), actor, confirm)) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
        }
        return decisions.find(meetingId, decisionId).orElseThrow(DecisionService::missing);
    }

    private static void validateContent(String content, int maxLength) {
        if (content == null || content.isBlank() || content.length() > maxLength) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
        }
    }

    private static ResponseStatusException missing() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND);
    }
}
