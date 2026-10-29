package com.sme.meetingassistant.api.notification.email;

import java.util.Optional;
import java.util.UUID;

/**
 * Provider-independent, purpose-specific renderer for one durable email intent.
 *
 * Implementations MUST verify that the referenced security/business action remains
 * eligible at send time. Ineligible actions return empty; transient errors throw to
 * trigger bounded queue retries. No raw token or rendered body is persisted.
 *
 * P4-T06 registers PASSWORD_RECOVERY here; it does not create another SMTP worker.
 */
public interface TransactionalEmailHandler {
    String notificationType();

    Optional<Content> compose(UUID relatedEntityId, String recipientEmail);

    record Content(String subject, String body) { }
}
