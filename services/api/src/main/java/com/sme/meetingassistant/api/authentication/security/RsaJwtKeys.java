package com.sme.meetingassistant.api.authentication.security;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ResourceLoader;
import org.springframework.stereotype.Component;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;

/** Trusted RS256 signing key and current/previous verification keys (no network JWKS fetch). */
@Component
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
public final class RsaJwtKeys {
    private final RSAPrivateKey signingKey;
    private final Map<String, RSAPublicKey> verificationKeys;
    private final String kid;
    private final String issuer;
    private final String audience;

    public RsaJwtKeys(ResourceLoader loader,
            @Value("${app.auth.jwt.private-key-location:}") String privateLocation,
            @Value("${app.auth.jwt.public-key-location:}") String publicLocation,
            @Value("${app.auth.jwt.key-id:}") String kid,
            @Value("${app.auth.jwt.previous-public-key-location:}") String oldPublicLocation,
            @Value("${app.auth.jwt.previous-key-id:}") String oldKid,
            @Value("${app.auth.jwt.issuer:}") String issuer,
            @Value("${app.auth.jwt.audience:}") String audience) {
        try {
            if (kid.isBlank() || issuer.isBlank() || audience.isBlank()
                    || privateLocation.isBlank() || publicLocation.isBlank()
                    || kid.length() > 96) throw new IllegalStateException("RS256 issuer, audience, kid and key locations are required");
            this.kid = kid;
            this.issuer = issuer;
            this.audience = audience;
            KeyFactory factory = KeyFactory.getInstance("RSA");
            signingKey = (RSAPrivateKey) factory.generatePrivate(new PKCS8EncodedKeySpec(
                pem(loader, privateLocation, "PRIVATE KEY")));
            RSAPublicKey current = (RSAPublicKey) factory.generatePublic(new X509EncodedKeySpec(
                pem(loader, publicLocation, "PUBLIC KEY")));
            validateSize(signingKey.getModulus().bitLength());
            validateSize(current.getModulus().bitLength());
            if (!signingKey.getModulus().equals(current.getModulus())) {
                throw new IllegalStateException("RS256 signing/verification keys do not match");
            }
            Map<String, RSAPublicKey> trusted = new LinkedHashMap<>();
            trusted.put(kid, current);
            if (!oldKid.isBlank() || !oldPublicLocation.isBlank()) {
                if (oldKid.isBlank() || oldPublicLocation.isBlank() || oldKid.equals(kid))
                    throw new IllegalStateException("Previous JWT key requires a distinct kid and public key");
                RSAPublicKey previous = (RSAPublicKey) factory.generatePublic(new X509EncodedKeySpec(
                    pem(loader, oldPublicLocation, "PUBLIC KEY")));
                validateSize(previous.getModulus().bitLength());
                trusted.put(oldKid, previous);
            }
            verificationKeys = Map.copyOf(trusted);
        } catch (Exception error) {
            // Never include key contents, PEM parser messages or resource locations in logs.
            throw new IllegalStateException("Invalid RS256 key or issuer/audience configuration");
        }
    }

    private static byte[] pem(ResourceLoader loader, String location, String kind) throws Exception {
        String raw;
        try (var input = loader.getResource(location).getInputStream()) {
            raw = new String(input.readAllBytes(), StandardCharsets.US_ASCII);
        }
        String base64 = raw.replace("-----BEGIN " + kind + "-----", "")
            .replace("-----END " + kind + "-----", "").replaceAll("\\s", "");
        return Base64.getDecoder().decode(base64);
    }

    private static void validateSize(int bits) {
        if (bits < 2048) throw new IllegalStateException("RSA key must be at least 2048 bits");
    }

    public RSAPrivateKey signingKey() { return signingKey; }
    public Map<String, RSAPublicKey> verificationKeys() { return verificationKeys; }
    public String kid() { return kid; }
    public String issuer() { return issuer; }
    public String audience() { return audience; }
}
