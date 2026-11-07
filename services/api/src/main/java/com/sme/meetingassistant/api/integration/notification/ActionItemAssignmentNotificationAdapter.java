package com.sme.meetingassistant.api.integration.notification;

import com.sme.meetingassistant.api.actionitems.application.ActionItemAssignmentEvents;
import com.sme.meetingassistant.api.actionitems.application.ActionItemAssignmentEligibility;
import com.sme.meetingassistant.api.notification.application.ActionItemAssignmentNotificationPort;
import com.sme.meetingassistant.api.userorganization.service.OrganizationalIdentityLookup;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

/**
 * The only cross-feature assignment notification adapter.
 * Action Items publishes its own event and imports no Notification service.
 * Delivery intent joins the business transaction; SMTP remains asynchronous.
 */
@Component
@ConditionalOnProperty(prefix = "app.notification", name = "action-item-assignment-enabled",
        havingValue = "true", matchIfMissing = false)
public final class ActionItemAssignmentNotificationAdapter {
    private final ActionItemAssignmentEvents assignments;
    private final ActionItemAssignmentEligibility eligibility;
    private final OrganizationalIdentityLookup identities;
    private final ActionItemAssignmentNotificationPort notifications;

    public ActionItemAssignmentNotificationAdapter(ActionItemAssignmentEvents assignments,
            ActionItemAssignmentEligibility eligibility, OrganizationalIdentityLookup identities,
            ActionItemAssignmentNotificationPort notifications) {
        this.assignments = assignments;
        this.eligibility = eligibility;
        this.identities = identities;
        this.notifications = notifications;
    }

    @TransactionalEventListener(phase = TransactionPhase.BEFORE_COMMIT)
    public void onAssigned(ActionItemAssignmentEvents.Recorded recorded) {
        // The event must exist in the canonical Action Items table.
        var event = assignments.require(recorded.eventId());
        // A later assignment in the same transaction may already supersede
        // this signal. Never enqueue an event that is no longer official.
        if (!eligibility.isCurrentOfficialAssignment(event.eventId(), event.assigneeUserId())) {
            return;
        }
        notifications.supersedeForActionItem(event.actionItemId(), event.eventId());
        var recipient = identities.activeRecipient(event.assigneeUserId());
        // Account revocation invalidates delivery, not the business event.
        if (recipient.isEmpty()) return;
        notifications.enqueueAssigned(event.eventId(), event.actionItemId(),
                event.assigneeUserId(), recipient.get().email());
    }

    @TransactionalEventListener(phase = TransactionPhase.BEFORE_COMMIT)
    public void onInvalidated(ActionItemAssignmentEvents.Invalidated revoked) {
        notifications.supersedeForActionItem(revoked.actionItemId(), null);
    }
}
