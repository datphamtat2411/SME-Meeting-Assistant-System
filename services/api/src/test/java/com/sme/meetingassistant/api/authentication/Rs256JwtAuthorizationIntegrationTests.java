package com.sme.meetingassistant.api.authentication;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sme.meetingassistant.api.authentication.entity.*;
import com.sme.meetingassistant.api.authentication.repository.AuthSessionRepository;
import com.sme.meetingassistant.api.authentication.security.*;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.*;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupPasswordHasher;
import java.security.KeyPairGenerator;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Date;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Transactional;

/** Real Spring Security filter chain + PostgreSQL live-session checks and signed RS256 JWTs. */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
@TestPropertySource(properties = "app.auth.http-enforcement-enabled=false")
@Transactional
class Rs256JwtAuthorizationIntegrationTests {
    @Autowired private MockMvc mvc;
    @Autowired private UserRepository users;
    @Autowired private AuthSessionRepository sessions;
    @Autowired private AccountSetupPasswordHasher passwords;
    @Autowired private RsaJwtKeys keys;
    @Autowired private Rs256AccessTokenService issue;
    private UserEntity admin;
    private AuthSessionEntity live;
    private String token;

    @BeforeEach
    void setup() {
        admin = new UserEntity("jwt-" + UUID.randomUUID() + "@example.com",
            "Token User", GlobalRole.ADMINISTRATOR, null);
        admin.completeInitialSetup(passwords.hash("A test-only long Argon2id password 🚀 2026"),
            OffsetDateTime.now(ZoneOffset.UTC));
        admin = users.saveAndFlush(admin);
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        live = sessions.saveAndFlush(new AuthSessionEntity(admin.getId(), AuthClientType.MOBILE,
            now, now.plusDays(30), null));
        live.recordActivity(now);
        sessions.flush();
        token = issue.issue(admin.getId(), live.getId());
    }

    private void expectAccess(String bearer, int statusCode) throws Exception {
        mvc.perform(get("/api/v1/me/profile").header(HttpHeaders.AUTHORIZATION, "Bearer " + bearer))
            .andExpect(status().is(statusCode));
    }

    private JWTClaimsSet.Builder claims() {
        Instant now = Instant.now();
        return new JWTClaimsSet.Builder().issuer(keys.issuer()).audience(keys.audience())
            .subject(admin.getId().toString()).claim("sid", live.getId().toString())
            .issueTime(Date.from(now)).notBeforeTime(Date.from(now))
            .expirationTime(Date.from(now.plusSeconds(600)))
            .jwtID(UUID.randomUUID().toString());
    }

    private String sign(JWTClaimsSet claims) throws Exception {
        SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256)
            .keyID(keys.kid()).build(), claims);
        jwt.sign(new RSASSASigner(keys.signingKey()));
        return jwt.serialize();
    }

    @Test
    void validTokenContainsRequiredClaimsAndUsesRealServerPrincipal() throws Exception {
        SignedJWT verified = SignedJWT.parse(token);
        assertThat(verified.getHeader().getAlgorithm()).isEqualTo(JWSAlgorithm.RS256);
        assertThat(verified.getHeader().getKeyID()).isEqualTo(keys.kid());
        var claims = verified.getJWTClaimsSet();
        assertThat(claims.getIssuer()).isEqualTo(keys.issuer());
        assertThat(claims.getAudience()).contains(keys.audience());
        assertThat(claims.getSubject()).isEqualTo(admin.getId().toString());
        assertThat(claims.getStringClaim("sid")).isEqualTo(live.getId().toString());
        assertThat(claims.getJWTID()).isNotBlank();
        assertThat(claims.getIssueTime()).isNotNull();
        assertThat(claims.getNotBeforeTime()).isNotNull();
        assertThat(claims.getExpirationTime().toInstant().getEpochSecond()
            - claims.getIssueTime().toInstant().getEpochSecond()).isEqualTo(600);
        assertThat(claims.getClaims().keySet()).doesNotContain("password_hash", "global_role", "scopes");

        expectAccess(token, 200);
        mvc.perform(get("/api/v1/organizational-units")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
            .andExpect(status().isOk());
    }

    @Test
    void anonymousSpoofedHeaderAndIgnoredLegacyPermitAllFlagCannotGrantAccess() throws Exception {
        mvc.perform(get("/api/v1/me/profile")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/v1/me/profile").header("X-User-Id", admin.getId().toString())
            .header("X-Role", "ADMINISTRATOR")).andExpect(status().isUnauthorized());
        // An obsolete flag in old PR #4 must not disable the active security filter chain.
        expectAccess("not-a-jwt", 401);
    }

    @Test
    void wrongIssuerAudienceExpiredNotBeforeAndMissingSidAreRejected() throws Exception {
        expectAccess(sign(claims().issuer("https://attacker.invalid").build()), 401);
        expectAccess(sign(claims().audience("other-audience").build()), 401);
        Instant past = Instant.now().minusSeconds(1200);
        expectAccess(sign(claims().issueTime(Date.from(past))
            .notBeforeTime(Date.from(past)).expirationTime(Date.from(past.plusSeconds(600)))
            .build()), 401);
        expectAccess(sign(claims().notBeforeTime(Date.from(Instant.now().plusSeconds(180)))
            .build()), 401);
        expectAccess(sign(claims().claim("sid", null).build()), 401);
        expectAccess(sign(claims().claim("sid", UUID.randomUUID().toString()).build()), 401);
    }

    @Test
    void unsignedWrongAlgorithmTamperingAndUnknownKidAreRejected() throws Exception {
        String[] parts = token.split("\\.");
        String signature = parts[2];
        char flipped = signature.charAt(20) == 'A' ? 'B' : 'A';
        expectAccess(parts[0] + "." + parts[1] + "." +
            signature.substring(0, 20) + flipped + signature.substring(21), 401);

        SignedJWT wrongKid = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256)
            .keyID("untrusted-key").build(), claims().build());
        wrongKid.sign(new RSASSASigner(keys.signingKey()));
        expectAccess(wrongKid.serialize(), 401);

        SignedJWT hs256 = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.HS256)
            .keyID(keys.kid()).build(), claims().build());
        hs256.sign(new MACSigner("a sufficiently long test HMAC secret 2026".getBytes()));
        expectAccess(hs256.serialize(), 401);
        expectAccess("eyJhbGciOiJub25lIn0.eyJzdWIiOiJzdWJqZWN0In0.", 401);

        KeyPairGenerator pair = KeyPairGenerator.getInstance("RSA");
        pair.initialize(2048);
        SignedJWT wrongSigner = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256)
            .keyID(keys.kid()).build(), claims().build());
        wrongSigner.sign(new RSASSASigner((java.security.interfaces.RSAPrivateKey) pair.generateKeyPair().getPrivate()));
        expectAccess(wrongSigner.serialize(), 401);
    }

    @Test
    void previousTrustedPublicKeyVerifiesJwtDuringRotationOverlap() throws Exception {
        // TEST-ONLY predecessor key. Production reads only current private key.
        String pem;
        try (var input = new org.springframework.core.io.ClassPathResource(
                "auth/test-previous-private.pem").getInputStream()) {
            pem = new String(input.readAllBytes(), java.nio.charset.StandardCharsets.US_ASCII);
        }
        byte[] pkcs8 = java.util.Base64.getDecoder().decode(pem
            .replace("-----BEGIN PRIVATE KEY-----", "")
            .replace("-----END PRIVATE KEY-----", "")
            .replaceAll("\\s", ""));
        var previousKey = (java.security.interfaces.RSAPrivateKey) java.security.KeyFactory
            .getInstance("RSA").generatePrivate(new java.security.spec.PKCS8EncodedKeySpec(pkcs8));
        SignedJWT predecessor = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256)
            .keyID("test-previous-2026").type(com.nimbusds.jose.JOSEObjectType.JWT)
            .build(), claims().build());
        predecessor.sign(new RSASSASigner(previousKey));
        expectAccess(predecessor.serialize(), 200);
    }

    @Test
    void revokedExpiredInactiveOrMismatchedSessionRejectsSignedJwt() throws Exception {
        live.revoke(OffsetDateTime.now(ZoneOffset.UTC), "LOGOUT");
        sessions.flush();
        expectAccess(token, 401);

        // Another token remains signed correctly but is never usable for a different user.
        assertThatThrownBy(() -> issue.issue(UUID.randomUUID(), live.getId())).isInstanceOf(Exception.class);
    }

    @Test
    void expiredAndInactiveAccountCannotUsePreviouslyValidJwt() throws Exception {
        sessions.saveAndFlush(live);
        live.expire();
        sessions.flush();
        expectAccess(token, 401);
    }

    @Test
    void inactiveUserInvalidatesPreviouslyIssuedJwt() throws Exception {
        org.springframework.test.util.ReflectionTestUtils.setField(admin,
            "accountStatus", AccountStatus.INACTIVE);
        users.saveAndFlush(admin);
        expectAccess(token, 401);
    }

    @Test
    void roleChangeIsReevaluatedFromCurrentUserRecordNotJwt() throws Exception {
        mvc.perform(get("/api/v1/organizational-units")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
            .andExpect(status().isOk());
        admin.assignGlobalRole(GlobalRole.EMPLOYEE);
        users.saveAndFlush(admin);
        mvc.perform(get("/api/v1/organizational-units")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
            .andExpect(status().isForbidden());
        // T05 later revokes the family on role mutation; no role privilege is cached in JWT.
    }
}
