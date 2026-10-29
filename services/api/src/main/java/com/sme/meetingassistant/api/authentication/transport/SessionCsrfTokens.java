package com.sme.meetingassistant.api.authentication.transport;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;

/**
 * Purpose-separated session-bound CSRF cookie. Bootstrap tokens bind to "prelogin",
 * authenticated tokens bind to UUID session IDs. Signed proof requires a matching
 * JS-readable cookie AND custom header; never an authentication bearer credential.
 */
@Component
@ConditionalOnProperty(prefix = "app.auth.transport", name = "enabled", havingValue = "true")
public class SessionCsrfTokens {
    private final byte[] key;
    private final SecureRandom random = new SecureRandom();

    public SessionCsrfTokens(@Value("${app.auth.csrf.signing-key:}") String configured) {
        try {
            this.key = Base64.getDecoder().decode(configured);
            if (key.length < 32) throw new IllegalArgumentException("short csrf key");
        } catch (Exception invalid) {
            throw new IllegalStateException("APP_AUTH_CSRF_SIGNING_KEY requires 32+ random Base64 bytes");
        }
    }

    public String issue(String binding) {
        byte[] nonce = new byte[24];
        random.nextBytes(nonce);
        String time = Long.toString(Instant.now().getEpochSecond());
        String randomPart = Base64.getUrlEncoder().withoutPadding().encodeToString(nonce);
        String message = time + "." + randomPart;
        return message + "." + signature(binding, message);
    }

    public boolean valid(String binding, String cookie, String header) {
        if (binding == null || cookie == null || header == null ||
                cookie.length() > 180 || !MessageDigest.isEqual(
                    cookie.getBytes(StandardCharsets.US_ASCII),
                    header.getBytes(StandardCharsets.US_ASCII))) return false;
        String[] parts = cookie.split("\\.", -1);
        if (parts.length != 3 || !parts[0].matches("[0-9]{10}")
                || !parts[1].matches("[A-Za-z0-9_-]{32}") ||
                !parts[2].matches("[A-Za-z0-9_-]{43}")) return false;
        try {
            long issued = Long.parseLong(parts[0]);
            long age = Instant.now().getEpochSecond() - issued;
            if (age < -30 || age > 86400 || ("prelogin".equals(binding) && age > 600)) return false;
            String expected = signature(binding, parts[0] + "." + parts[1]);
            return MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII),
                parts[2].getBytes(StandardCharsets.US_ASCII));
        } catch (Exception invalid) {
            return false;
        }
    }

    private String signature(String binding, String value) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            byte[] signed = mac.doFinal(("sme-csrf-v1|" + binding + "|" + value)
                .getBytes(StandardCharsets.UTF_8));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(signed);
        } catch (Exception failure) {
            throw new IllegalStateException("CSRF signing unavailable");
        }
    }
}
