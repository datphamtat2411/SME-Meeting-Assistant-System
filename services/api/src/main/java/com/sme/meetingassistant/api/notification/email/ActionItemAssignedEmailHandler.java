package com.sme.meetingassistant.api.notification.email;

import com.sme.meetingassistant.api.actionitems.application.ActionItemAssignmentEligibility;
import com.sme.meetingassistant.api.notification.application.EmailNotificationPreferenceLookup;
import com.sme.meetingassistant.api.userorganization.service.OrganizationalIdentityLookup;
import java.util.Optional;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * Fail-closed Action Item assignment renderer. Every required fact is
 * revalidated from authoritative committed state immediately before SMTP:
 * event/version, latest assignment, official status, terminal revocation,
 * active identity, exact approved email and current user preference.
 */
@ConditionalOnProperty(prefix = "app.notification",
        name = {"action-item-assignment-enabled", "action-item-assignment-delivery-enabled"},
        havingValue = "true", matchIfMissing = false)
@Component
public final class ActionItemAssignedEmailHandler implements TransactionalEmailHandler {
    private final ActionItemAssignmentEligibility assignments;
    private final OrganizationalIdentityLookup identities;
    private final EmailNotificationPreferenceLookup preferences;

    public ActionItemAssignedEmailHandler(ActionItemAssignmentEligibility assignments,
            OrganizationalIdentityLookup identities, EmailNotificationPreferenceLookup preferences) {
        this.assignments = assignments;
        this.identities = identities;
        this.preferences = preferences;
    }

    @Override
    public String notificationType() {
        return "ACTION_ITEM_ASSIGNED";
    }

    /** Legacy renderer lacks recipient ID and entity type, so must fail closed. */
    @Override
    public Optional<Content> compose(UUID assignmentEventId, String recipientEmail) {
        return Optional.empty();
    }

    @Override
    public Prepared prepare(DeliveryContext delivery) {
        if (delivery == null || delivery.relatedEntityId() == null
                || delivery.recipientUserId() == null
                || delivery.recipientEmail() == null
                || !"ACTION_ITEM_ASSIGNMENT".equals(delivery.relatedEntityType())) {
            return Prepared.skipped("ACTION_NO_LONGER_ELIGIBLE");
        }
        if (!assignments.isCurrentOfficialAssignment(
                delivery.relatedEntityId(), delivery.recipientUserId())) {
            return Prepared.skipped("ACTION_NO_LONGER_ELIGIBLE");
        }
        var recipient = identities.activeRecipient(delivery.recipientUserId());
        if (recipient.isEmpty()
                || !delivery.recipientEmail().equals(recipient.get().email())) {
            // Do not silently forward an old intent to a changed/new address.
            return Prepared.skipped("RECIPIENT_NO_LONGER_ELIGIBLE");
        }
        if (!preferences.actionItemEmailEnabled(delivery.recipientUserId())) {
            return Prepared.skipped("USER_PREFERENCE_DISABLED");
        }
        return Prepared.ready(new Content("Action item assigned",
            "An action item has been assigned to you. Sign in to the SME Meeting Assistant to review it."));
    }
}
