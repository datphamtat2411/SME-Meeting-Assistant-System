package com.sme.meetingassistant.api.authentication.security;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import java.time.Instant;
import java.util.Date;
import java.util.UUID;
import org.springframework.security.oauth2.jwt.BadJwtException;
import org.springframework.stereotype.Service;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;

/** Server-internal, short-lived access token issuance; never an HTTP endpoint. */
@Service
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
public class Rs256AccessTokenService {
    private final RsaJwtKeys keys;
    private final SessionAuthority authority;

    public Rs256AccessTokenService(RsaJwtKeys keys, SessionAuthority authority) {
        this.keys = keys;
        this.authority = authority;
    }

    public String issue(UUID userId, UUID sessionId) {
        if (userId == null || sessionId == null || !authority.isLive(userId, sessionId))
            throw new BadJwtException("Inactive account or session");
        Instant now = Instant.now();
        JWTClaimsSet claims = new JWTClaimsSet.Builder()
            .issuer(keys.issuer()).audience(keys.audience()).subject(userId.toString())
            .claim("sid", sessionId.toString())
            .issueTime(Date.from(now)).notBeforeTime(Date.from(now))
            .expirationTime(Date.from(now.plusSeconds(600)))
            .jwtID(UUID.randomUUID().toString()).build();
        try {
            SignedJWT token = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256)
                .type(JOSEObjectType.JWT).keyID(keys.kid()).build(), claims);
            token.sign(new RSASSASigner(keys.signingKey()));
            return token.serialize();
        } catch (Exception error) {
            throw new IllegalStateException("RS256 signing failed");
        }
    }
}
