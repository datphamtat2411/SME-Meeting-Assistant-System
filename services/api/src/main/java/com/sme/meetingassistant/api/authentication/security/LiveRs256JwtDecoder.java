package com.sme.meetingassistant.api.authentication.security;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jwt.SignedJWT;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.security.oauth2.jwt.BadJwtException;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;

/**
 * RS256 algorithm allowlist plus trusted kid selection; no JWT-supplied JWK URL/algorithm.
 * Each protected request performs a fresh canonical DB account+session check.
 */
public final class LiveRs256JwtDecoder implements JwtDecoder {
    private static final Duration SKEW = Duration.ofSeconds(30);
    private final RsaJwtKeys keys;
    private final SessionAuthority authority;
    private final Map<String, JwtDecoder> decoders;

    public LiveRs256JwtDecoder(RsaJwtKeys keys, SessionAuthority authority) {
        this.keys = keys;
        this.authority = authority;
        Map<String, JwtDecoder> accepted = new LinkedHashMap<>();
        keys.verificationKeys().forEach((kid, rsa) -> accepted.put(kid,
            NimbusJwtDecoder.withPublicKey(rsa)
                .signatureAlgorithm(SignatureAlgorithm.RS256).build()));
        this.decoders = Map.copyOf(accepted);
    }

    @Override
    public Jwt decode(String raw) throws JwtException {
        try {
            SignedJWT signed = SignedJWT.parse(raw);
            if (!JWSAlgorithm.RS256.equals(signed.getHeader().getAlgorithm())) invalid();
            String kid = signed.getHeader().getKeyID();
            JwtDecoder trusted = kid == null ? null : decoders.get(kid);
            if (trusted == null) invalid();
            Jwt token = trusted.decode(raw); // signature is verified before any claim is trusted
            if (!keys.issuer().equals(token.getClaimAsString("iss"))
                    || !token.getAudience().contains(keys.audience())) invalid();
            Instant now = Instant.now();
            Instant issuedAt = token.getIssuedAt();
            Instant notBefore = token.getNotBefore();
            Instant expiresAt = token.getExpiresAt();
            if (issuedAt == null || notBefore == null || expiresAt == null
                    || expiresAt.isBefore(issuedAt) || expiresAt.isAfter(issuedAt.plusSeconds(600))
                    || issuedAt.isAfter(now.plus(SKEW))
                    || notBefore.isAfter(now.plus(SKEW))
                    || !expiresAt.isAfter(now.minus(SKEW))) invalid();

            String jti = token.getClaimAsString("jti");
            String sid = token.getClaimAsString("sid");
            String sub = token.getSubject();
            if (jti == null || sid == null || sub == null) invalid();
            UUID.fromString(jti);
            UUID sessionId = UUID.fromString(sid);
            UUID userId = UUID.fromString(sub);
            if (!authority.isLive(userId, sessionId)) invalid();
            return token;
        } catch (JwtException error) {
            throw error;
        } catch (Exception badToken) {
            throw new BadJwtException("Invalid or inactive access token");
        }
    }

    private static void invalid() {
        throw new BadJwtException("Invalid or inactive access token");
    }
}
