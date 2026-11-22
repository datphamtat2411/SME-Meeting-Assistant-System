package com.sme.meetingassistant.api.userorganization.bootstrap;

import com.sme.meetingassistant.api.userorganization.service.EmailNormalizer;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Explicit operator intent for the command-only first-administrator bootstrap.
 * These values are never read by an HTTP controller.
 */
@ConfigurationProperties(prefix = "app.initial-administrator-bootstrap")
public record InitialAdministratorBootstrapProperties(
        boolean enabled,
        String confirmation,
        String email,
        String displayName) {

    public static final String CONFIRMATION =
        "I_UNDERSTAND_INITIAL_ADMINISTRATOR_BOOTSTRAP";

    public void requireOperatorIntent() {
        if (!CONFIRMATION.equals(confirmation)) {
            throw new IllegalStateException(
                "Initial administrator bootstrap requires explicit operator confirmation");
        }
        validateIdentity(email, displayName);
    }

    static void validateIdentity(String email, String displayName) {
        String normalized = EmailNormalizer.normalize(email);
        if (normalized.length() > 320
                || normalized.indexOf('@') <= 0
                || normalized.indexOf('@') != normalized.lastIndexOf('@')
                || normalized.chars().anyMatch(Character::isWhitespace)) {
            throw new IllegalArgumentException("Initial administrator email is invalid");
        }
        if (displayName == null || displayName.isBlank()
                || displayName.trim().length() > 200
                || displayName.chars().anyMatch(character -> character < 0x20 || character == 0x7f)) {
            throw new IllegalArgumentException(
                "Initial administrator display name is invalid");
        }
    }
}
