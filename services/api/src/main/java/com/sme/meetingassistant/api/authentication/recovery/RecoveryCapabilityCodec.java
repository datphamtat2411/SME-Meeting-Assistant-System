package com.sme.meetingassistant.api.authentication.recovery;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * 256-bit CSPRNG nonce plus purpose-specific HMAC-SHA256. Stored nonce alone is
 * NOT a token and cannot authorize reset without the deployment-only HMAC key.
 * PostgreSQL stores SHA-256 verifier of the complete bearer, never the bearer.
 * The worker can reconstruct the same bearer for bounded SMTP retries.
 */
@Component
@ConditionalOnProperty(prefix="app.auth.recovery",name="enabled",havingValue="true")
public final class RecoveryCapabilityCodec {
    private static final String PURPOSE="sme-password-recovery-v1|";
    private final SecureRandom random=new SecureRandom();
    private final byte[] key;
    public RecoveryCapabilityCodec(@Value("${app.auth.recovery.signing-key:}") String configured) {
        try {
            key=Base64.getDecoder().decode(configured);
            if (key.length < 32) throw new IllegalArgumentException();
        } catch (RuntimeException invalid) {
            throw new IllegalStateException("Recovery signing key requires 32+ Base64 CSPRNG bytes");
        }
    }
    public byte[] nonce() {
        byte[] data=new byte[32];
        random.nextBytes(data);
        return data;
    }
    public String issue(UUID id, byte[] nonce) {
        if (id==null || nonce==null || nonce.length!=32) throw new IllegalArgumentException("Invalid recovery nonce");
        String value=id+"."+Base64.getUrlEncoder().withoutPadding().encodeToString(nonce);
        return value+"."+Base64.getUrlEncoder().withoutPadding()
            .encodeToString(hmac(PURPOSE+value));
    }
    public UUID parseId(String raw) {
        if (raw==null || raw.length()>180) return null;
        String[] parts=raw.split("\\.",-1);
        if(parts.length!=3 || !parts[1].matches("[A-Za-z0-9_-]{43}")
                || !parts[2].matches("[A-Za-z0-9_-]{43}")) return null;
        try {return UUID.fromString(parts[0]);}
        catch (IllegalArgumentException ignored) {return null;}
    }
    public String verifier(String raw) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(raw.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception impossible) { throw new IllegalStateException("SHA-256 unavailable"); }
    }
    public boolean valid(UUID id, byte[] nonce, String raw, String savedVerifier) {
        if (id==null || nonce==null || raw==null || savedVerifier==null
                || !id.equals(parseId(raw))) return false;
        return MessageDigest.isEqual(issue(id,nonce).getBytes(StandardCharsets.US_ASCII),
                    raw.getBytes(StandardCharsets.US_ASCII))
            && MessageDigest.isEqual(verifier(raw).getBytes(StandardCharsets.US_ASCII),
                    savedVerifier.getBytes(StandardCharsets.US_ASCII));
    }
    public String sourceFingerprint(String remoteAddress) {
        if (remoteAddress==null || remoteAddress.isBlank()) remoteAddress="unidentified";
        return HexFormat.of().formatHex(hmac("sme-recovery-ip-v1|"+remoteAddress));
    }
    private byte[] hmac(String input) {
        try {
            Mac mac=Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key,"HmacSHA256"));
            return mac.doFinal(input.getBytes(StandardCharsets.UTF_8));
        } catch(Exception impossible) {throw new IllegalStateException("Recovery crypto unavailable");}
    }
}
