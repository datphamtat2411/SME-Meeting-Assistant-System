package com.sme.meetingassistant.api.authentication.service;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.stereotype.Component;

@Component
public class JwtTokenService {
    private final JwtEncoder encoder;
    private final java.time.Duration accessTtl;
    public JwtTokenService(JwtEncoder encoder, @Value("${app.auth.jwt.access-ttl:PT15M}") java.time.Duration accessTtl) {
        this.encoder = encoder; this.accessTtl = accessTtl;
    }
    public IssuedAccessToken issue(UUID userId, String email) {
        Instant issuedAt = Instant.now();
        Instant expiresAt = issuedAt.plus(accessTtl);
        JwtClaimsSet claims = JwtClaimsSet.builder().issuer("sme-meeting-assistant-api")
                .subject(userId.toString()).issuedAt(issuedAt).expiresAt(expiresAt)
                .claim("email", email).build();
        String value = encoder.encode(JwtEncoderParameters.from(
                JwsHeader.with(MacAlgorithm.HS256).build(), claims)).getTokenValue();
        return new IssuedAccessToken(value, expiresAt);
    }
    public record IssuedAccessToken(String value, Instant expiresAt) {
        public long expiresInSeconds() { return Math.max(0, expiresAt.getEpochSecond() - Instant.now().getEpochSecond()); }
    }
}
