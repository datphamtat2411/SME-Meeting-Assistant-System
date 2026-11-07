package com.sme.meetingassistant.api.notification.application;

import java.util.UUID;

/**
 * Notification's transactional delivery-intent boundary. Only the integration
 * adapter may pass a verified canonical Action Items assignment event.
 */
public interface ActionItemAssignmentNotificationPort {
    /**
     * Must join the authoritative Action Item transaction. The event ID is
     * immutable and identifies a single audited assignment, not a task alone.
     * SMTP is never invoked through this port.
     */
    void enqueueAssigned(UUID eventId, UUID actionItemId, UUID assigneeUserId,
            String recipientEmail);

    /** Supersede obsolete unsent assignment intents in the authoritative transaction. */
    void supersedeForActionItem(UUID actionItemId, UUID stillCurrentEventId);
}
