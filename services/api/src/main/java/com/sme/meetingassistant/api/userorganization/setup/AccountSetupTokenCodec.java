package com.sme.meetingassistant.api.userorganization.setup;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HexFormat;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Purpose-specific capability reconstructed for retry; no plaintext token is persisted. */
@Component
public final class AccountSetupTokenCodec {
    private static final String PURPOSE = "sme-account-setup-v1:";
    private final String signingKey;

    public AccountSetupTokenCodec(@Value("${app.account-setup.signing-key:}") String signingKey) {
        this.signingKey = signingKey;
    }

    public String issue(UUID id) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key(), "HmacSHA256"));
            byte[] signature = mac.doFinal((PURPOSE + id).getBytes(StandardCharsets.UTF_8));
            return id + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(signature);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("Account setup cryptography unavailable", e);
        }
    }

    public String sha256(String raw) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(raw.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    public UUID parseId(String token) {
        if (token == null || token.length() > 180) return null;
        int dot = token.indexOf('.');
        if (dot < 0 || token.indexOf('.', dot + 1) >= 0) return null;
        try {
            return UUID.fromString(token.substring(0, dot));
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    public boolean verify(UUID id, String raw, String storedHash) {
        if (id == null || raw == null || storedHash == null || !id.equals(parseId(raw))) return false;
        return MessageDigest.isEqual(storedHash.getBytes(StandardCharsets.US_ASCII),
                                     sha256(raw).getBytes(StandardCharsets.US_ASCII))
            && MessageDigest.isEqual(issue(id).getBytes(StandardCharsets.US_ASCII),
                                     raw.getBytes(StandardCharsets.US_ASCII));
    }

    private byte[] key() {
        if (signingKey == null || signingKey.isBlank())
            throw new IllegalStateException("APP_ACCOUNT_SETUP_SIGNING_KEY must be configured");
        try {
            byte[] raw = Base64.getDecoder().decode(signingKey);
            if (raw.length < 32) throw new IllegalStateException("Setup signing key must be at least 32 bytes");
            return raw;
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException("APP_ACCOUNT_SETUP_SIGNING_KEY must be Base64", e);
        }
    }
}
