package com.sme.meetingassistant.api.notification.email;

import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

/**
 * Provider-independent, purpose-specific renderer for a durable email intent.
 * Compose/prepare MUST recheck authorization and eligibility at send time.
 * Ineligible actions are SKIPPED; transient database/SMTP errors are retried.
 */
public interface TransactionalEmailHandler {
    String notificationType();

    /** Legacy purpose-specific renderer; retained for all existing handlers. */
    Optional<Content> compose(UUID relatedEntityId, String recipientEmail);

    /**
     * Extended delivery context preserves the durable queue's authoritative
     * recipient user ID and entity kind, without changing Meeting/Account handlers.
     */
    record DeliveryContext(UUID relatedEntityId, String relatedEntityType,
                           UUID recipientUserId, String recipientEmail) {}

    record Prepared(Optional<Content> content, String skipReason) {
        public Prepared {
            Objects.requireNonNull(content, "Prepared content cannot be null");
            if (content.isEmpty() && (skipReason == null || skipReason.isBlank())) {
                throw new IllegalArgumentException("Ineligible delivery requires an audit reason");
            }
            if (skipReason != null && (skipReason.length() > 96
                    || !skipReason.matches("[A-Z][A-Z0-9_]*"))) {
                throw new IllegalArgumentException("Invalid delivery disposition reason");
            }
        }
        public static Prepared ready(Content content) {
            return new Prepared(Optional.of(Objects.requireNonNull(content)), null);
        }
        public static Prepared skipped(String reason) {
            return new Prepared(Optional.empty(), reason);
        }
    }

    default Prepared prepare(DeliveryContext delivery) {
        return compose(delivery.relatedEntityId(), delivery.recipientEmail())
            .map(Prepared::ready)
            .orElseGet(() -> Prepared.skipped("ACTION_NO_LONGER_ELIGIBLE"));
    }

    record Content(String subject, String body) {}
}
