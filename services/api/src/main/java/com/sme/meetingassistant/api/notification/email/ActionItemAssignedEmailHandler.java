package com.sme.meetingassistant.api.notification.email;

import java.util.Optional;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/** A privacy-minimal renderer for one official action-item assignment. */
@ConditionalOnProperty(prefix = "app.notification", name = "action-item-assignment-enabled",
        havingValue = "true", matchIfMissing = false)
@Component
public final class ActionItemAssignedEmailHandler implements TransactionalEmailHandler {
    @Override
    public String notificationType() {
        return "ACTION_ITEM_ASSIGNED";
    }

    @Override
    public Optional<Content> compose(UUID actionItemId, String recipientEmail) {
        if (actionItemId == null || recipientEmail == null || recipientEmail.isBlank()) {
            return Optional.empty();
        }
        return Optional.of(new Content("Action item assigned",
            "An action item has been assigned to you. Sign in to the SME Meeting Assistant to review it."));
    }
}
