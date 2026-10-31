package com.sme.meetingassistant.api.notification.application;

import java.util.UUID;

/**
 * Application boundary for the authoritative Action Items feature to request
 * assignment mail in the same transaction as its assignment event.
 */
public interface ActionItemAssignmentNotificationPort {
    /**
     * Enqueues one committed assignment or reassignment. The producer supplies a
     * stable event ID for retries and the approved email snapshot for that event.
     */
    void enqueueAssigned(UUID eventId, UUID actionItemId, UUID assigneeUserId,
            String recipientEmail);
}
