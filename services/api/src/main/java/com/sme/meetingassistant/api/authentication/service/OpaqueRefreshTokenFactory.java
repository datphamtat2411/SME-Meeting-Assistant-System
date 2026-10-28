package com.sme.meetingassistant.api.authentication.service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;
import org.springframework.stereotype.Component;

/** CSPRNG-backed opaque credential and one-way SHA-256 verifier. No plaintext is persisted. */
@Component
public final class OpaqueRefreshTokenFactory {
    private final SecureRandom random = new SecureRandom();

    public IssuedRefreshToken issue() {
        byte[] secret = new byte[48];
        random.nextBytes(secret);
        String raw = Base64.getUrlEncoder().withoutPadding().encodeToString(secret);
        return new IssuedRefreshToken(raw, hash(raw));
    }

    public String hash(String raw) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(raw.getBytes(StandardCharsets.US_ASCII)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    public record IssuedRefreshToken(String raw, String hash) {}
}
