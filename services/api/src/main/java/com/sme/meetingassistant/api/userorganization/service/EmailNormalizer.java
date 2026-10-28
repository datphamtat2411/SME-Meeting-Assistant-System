package com.sme.meetingassistant.api.userorganization.service;

import java.util.Locale;

/** One deterministic normalization routine for creation, lookup, and future email changes. */
public final class EmailNormalizer {
    private EmailNormalizer() { }

    public static String normalize(String email) {
        if (email == null || email.isBlank()) {
            throw new IllegalArgumentException("Email must not be blank");
        }
        return email.trim().toLowerCase(Locale.ROOT);
    }
}
