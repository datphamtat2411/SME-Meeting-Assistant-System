package com.sme.meetingassistant.api.notification.email;

import java.util.Optional;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * Provisional renderer retained from teammate branch. Delivery stays OFF until
 * AI-08.4 implements send-time canonical eligibility and recipient revalidation.
 */
@ConditionalOnProperty(prefix = "app.notification", name = "action-item-assignment-delivery-enabled",
        havingValue = "true", matchIfMissing = false)
@Component
public final class ActionItemAssignedEmailHandler implements TransactionalEmailHandler {
    @Override
    public String notificationType() {
        return "ACTION_ITEM_ASSIGNED";
    }

    @Override
    public Optional<Content> compose(UUID assignmentEventId, String recipientEmail) {
        if (assignmentEventId == null || recipientEmail == null || recipientEmail.isBlank()) {
            return Optional.empty();
        }
        return Optional.of(new Content("Action item assigned",
            "An action item has been assigned to you. Sign in to the SME Meeting Assistant to review it."));
    }
}
