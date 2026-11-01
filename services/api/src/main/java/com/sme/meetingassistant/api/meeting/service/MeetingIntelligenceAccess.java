package com.sme.meetingassistant.api.meeting.service;

import java.util.UUID;

/**
 * Meeting-owned authorization boundary for protected meeting-intelligence content.
 * Callers must pass the authenticated actor, not a user ID supplied by a client.
 * Explicit delegated permissions are not implemented in the current Meeting model;
 * until approved, only the organizer may mutate intelligence content.
 */
public interface MeetingIntelligenceAccess {
    void requireIntelligenceReadable(UUID meetingId, UUID actorId);
    void requireSummaryEditAllowed(UUID meetingId, UUID actorId);
    void requireSummaryRegenerationAllowed(UUID meetingId, UUID actorId);
    void requireDecisionEditAllowed(UUID meetingId, UUID actorId);
    void requireDecisionReviewAllowed(UUID meetingId, UUID actorId);
}
