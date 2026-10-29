package com.sme.meetingassistant.api.authentication;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.authentication.entity.*;
import com.sme.meetingassistant.api.authentication.repository.*;
import com.sme.meetingassistant.api.authentication.security.*;
import com.sme.meetingassistant.api.authentication.service.*;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.*;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupPasswordHasher;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.server.ResponseStatusException;

/**
 * No enclosing @Transactional on purpose: replay/logout must COMMIT revocation
 * before an invalid refresh is reported to its caller.
 */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class RefreshSessionIntegrationTests {
    @Autowired private UserRepository users;
    @Autowired private AuthSessionRepository sessions;
    @Autowired private RefreshTokenRepository refreshTokens;
    @Autowired private AccountSetupPasswordHasher passwords;
    @Autowired private LoginAdmissionService login;
    @Autowired private RefreshSessionService refresh;
    @Autowired private OpaqueRefreshTokenFactory secrets;
    @Autowired private Rs256AccessTokenService accessTokens;
    @Autowired private SessionAuthority authority;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private MockMvc mvc;

    private static final String PASSWORD = "A strong Unicode password for refresh 🧪 2026!";

    private UserEntity activeUser() {
        UserEntity account = new UserEntity("rt-" + UUID.randomUUID() + "@example.com",
            "Refresh Test User", GlobalRole.EMPLOYEE, null);
        account.completeInitialSetup(passwords.hash(PASSWORD), OffsetDateTime.now(ZoneOffset.UTC));
        return users.saveAndFlush(account);
    }

    private LoginAdmissionService.AdmittedLogin loggedIn(UserEntity u, AuthClientType client) {
        return login.authenticateAndAdmit(u.getEmail(), PASSWORD, client);
    }

    private static void rejects(org.junit.jupiter.api.function.Executable call) {
        assertThatThrownBy(call::execute).isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> {
                var status = (ResponseStatusException) error;
                assertThat(status.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
                assertThat(status.getReason()).isEqualTo("Invalid refresh credentials");
            });
    }

    @Test
    void successfulRotationConsumesAOnceAndPersistsExactlyOneB() {
        var admission = loggedIn(activeUser(), AuthClientType.MOBILE);
        var tokensBefore = refreshTokens.findBySessionIdOrderByIssuedAtAsc(admission.sessionId());
        assertThat(tokensBefore).hasSize(1);
        var original = tokensBefore.getFirst();
        var next = refresh.rotate(admission.refreshToken(), AuthClientType.MOBILE);

        assertThat(next.sessionId()).isEqualTo(admission.sessionId());
        assertThat(next.userId()).isEqualTo(admission.userId());
        assertThat(next.clientType()).isEqualTo(AuthClientType.MOBILE);
        assertThat(next.refreshToken()).isNotEqualTo(admission.refreshToken());
        assertThat(next.refreshToken()).matches("[A-Za-z0-9_-]{64}");
        assertThat(refreshTokens.findBySessionIdOrderByIssuedAtAsc(admission.sessionId())).hasSize(2);
        var consumed = refreshTokens.findById(original.getId()).orElseThrow();
        var child = refreshTokens.findById(consumed.getReplacedByTokenId()).orElseThrow();
        assertThat(consumed.getConsumedAt()).isNotNull();
        assertThat(consumed.getRevokedAt()).isNull();
        assertThat(child.getTokenHash()).isEqualTo(secrets.hash(next.refreshToken()));
        assertThat(child.getTokenHash()).doesNotContain(next.refreshToken());
        assertThat(child.getSessionId()).isEqualTo(admission.sessionId());
        assertThat(sessions.findById(admission.sessionId()).orElseThrow().getStatus())
            .isEqualTo(AuthSessionStatus.ACTIVE);
        var nextAgain = refresh.rotate(next.refreshToken(), AuthClientType.MOBILE);
        assertThat(nextAgain.refreshToken()).isNotEqualTo(next.refreshToken());
        assertThat(refreshTokens.findBySessionIdOrderByIssuedAtAsc(admission.sessionId())).hasSize(3);
    }

    @Test
    void reusedACommitsFamilyRevocationAndBlocksBAndOldSignedJwt() throws Exception {
        var admission = loggedIn(activeUser(), AuthClientType.MOBILE);
        var bearer = accessTokens.issue(admission.userId(), admission.sessionId());
        var next = refresh.rotate(admission.refreshToken(), AuthClientType.MOBILE);
        mvc.perform(get("/api/v1/me/profile")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + bearer)).andExpect(status().isOk());

        rejects(() -> refresh.rotate(admission.refreshToken(), AuthClientType.MOBILE));

        // A rejected API operation must not roll back the security response.
        var family = sessions.findById(admission.sessionId()).orElseThrow();
        assertThat(family.getStatus()).isEqualTo(AuthSessionStatus.REVOKED);
        assertThat(family.getRevokeReason()).isEqualTo("REFRESH_REUSE");
        assertThat(family.getRevokedAt()).isNotNull();
        assertThat(refreshTokens.findBySessionIdOrderByIssuedAtAsc(family.getId()))
            .hasSize(2).allSatisfy(t -> assertThat(t.getRevokedAt()).isNotNull());
        rejects(() -> refresh.rotate(next.refreshToken(), AuthClientType.MOBILE));
        assertThat(authority.isLive(admission.userId(), family.getId())).isFalse();
        mvc.perform(get("/api/v1/me/profile")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + bearer))
            .andExpect(status().isUnauthorized());
    }

    @Test
    void missingUnknownMalformedAndAccessJwtCannotRefreshAndDoNotRevokeSession() {
        var admission = loggedIn(activeUser(), AuthClientType.WEB);
        var access = accessTokens.issue(admission.userId(), admission.sessionId());
        rejects(() -> refresh.rotate(null, AuthClientType.WEB));
        rejects(() -> refresh.rotate("", AuthClientType.WEB));
        rejects(() -> refresh.rotate(access, AuthClientType.WEB));
        rejects(() -> refresh.rotate(secrets.issue().raw(), AuthClientType.WEB));
        rejects(() -> refresh.rotate(admission.refreshToken(), null));
        assertThat(sessions.findById(admission.sessionId()).orElseThrow().getStatus())
            .isEqualTo(AuthSessionStatus.ACTIVE);
        assertThat(refreshTokens.findBySessionIdOrderByIssuedAtAsc(admission.sessionId())).hasSize(1);
    }

    @Test
    void refreshingFromOtherClientContextDoesNotConsumeOrRevoke() {
        var admission = loggedIn(activeUser(), AuthClientType.WEB);
        rejects(() -> refresh.rotate(admission.refreshToken(), AuthClientType.MOBILE));
        assertThat(refreshTokens.findBySessionIdOrderByIssuedAtAsc(admission.sessionId())
            .getFirst().getConsumedAt()).isNull();
        var rotated = refresh.rotate(admission.refreshToken(), AuthClientType.WEB);
        assertThat(rotated.sessionId()).isEqualTo(admission.sessionId());
    }

    @Test
    void absoluteExpiryNeverMovesAndReplacementIsCappedBySessionDeadline() {
        var admission = loggedIn(activeUser(), AuthClientType.MOBILE);
        OffsetDateTime absolute = admission.absoluteSessionExpiresAt();
        jdbc.update("""
            UPDATE auth_sessions SET absolute_expires_at=clock_timestamp() + INTERVAL '20 minutes'
            WHERE id=?
            """, admission.sessionId());
        var result = refresh.rotate(admission.refreshToken(), AuthClientType.MOBILE);
        var family = sessions.findById(admission.sessionId()).orElseThrow();
        assertThat(result.absoluteSessionExpiresAt()).isEqualTo(family.getAbsoluteExpiresAt());
        assertThat(result.refreshExpiresAt()).isEqualTo(family.getAbsoluteExpiresAt());
        assertThat(result.absoluteSessionExpiresAt()).isBefore(absolute);
        var next = refresh.rotate(result.refreshToken(), AuthClientType.MOBILE);
        assertThat(next.absoluteSessionExpiresAt()).isEqualTo(result.absoluteSessionExpiresAt());
        assertThat(next.refreshExpiresAt()).isEqualTo(result.refreshExpiresAt());
    }

    @Test
    void inactivityExpirationPersistsAndCannotRotateEvenIfTokenRowLooksValid() {
        var admission = loggedIn(activeUser(), AuthClientType.MOBILE);
        jdbc.update("""
            UPDATE auth_sessions SET last_seen_at=clock_timestamp() - INTERVAL '8 days'
            WHERE id=?
            """, admission.sessionId());
        rejects(() -> refresh.rotate(admission.refreshToken(), AuthClientType.MOBILE));
        assertThat(sessions.findById(admission.sessionId()).orElseThrow().getStatus())
            .isEqualTo(AuthSessionStatus.EXPIRED);
        rejects(() -> refresh.rotate(admission.refreshToken(), AuthClientType.MOBILE));
    }

    @Test
    void expiredTokenRejectsEvenWhenSessionIsStillActive() {
        var admission = loggedIn(activeUser(), AuthClientType.MOBILE);
        jdbc.update("""
            UPDATE refresh_tokens SET issued_at=clock_timestamp() - INTERVAL '1 hour',
                expires_at=clock_timestamp() - INTERVAL '1 second'
            WHERE session_id=?
            """, admission.sessionId());
        rejects(() -> refresh.rotate(admission.refreshToken(), AuthClientType.MOBILE));
        assertThat(sessions.findById(admission.sessionId()).orElseThrow().getStatus())
            .isEqualTo(AuthSessionStatus.ACTIVE);
        assertThat(refreshTokens.findBySessionIdOrderByIssuedAtAsc(admission.sessionId())).hasSize(1);
    }

    @Test
    void logoutIsIdempotentRevokesCurrentFamilyOnlyAndInvalidatesJwt() throws Exception {
        var user = activeUser();
        var first = loggedIn(user, AuthClientType.WEB);
        var second = loggedIn(user, AuthClientType.MOBILE);
        String firstJwt = accessTokens.issue(user.getId(), first.sessionId());
        refresh.logout(user.getId(), first.sessionId());
        refresh.logout(user.getId(), first.sessionId());
        assertThat(sessions.findById(first.sessionId()).orElseThrow().getStatus())
            .isEqualTo(AuthSessionStatus.REVOKED);
        assertThat(sessions.findById(first.sessionId()).orElseThrow().getRevokeReason())
            .isEqualTo("LOGOUT");
        assertThat(refreshTokens.findBySessionIdOrderByIssuedAtAsc(first.sessionId())
            .getFirst().getRevokedAt()).isNotNull();
        rejects(() -> refresh.rotate(first.refreshToken(), AuthClientType.WEB));
        mvc.perform(get("/api/v1/me/profile")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + firstJwt))
            .andExpect(status().isUnauthorized());
        assertThat(refresh.rotate(second.refreshToken(), AuthClientType.MOBILE).sessionId())
            .isEqualTo(second.sessionId());
    }

    @Test
    void spoofedLogoutTargetCannotRevokeAnotherUsersSession() {
        var owner = activeUser();
        var other = activeUser();
        var first = loggedIn(owner, AuthClientType.MOBILE);
        refresh.logout(other.getId(), first.sessionId());
        assertThat(refresh.rotate(first.refreshToken(), AuthClientType.MOBILE).sessionId())
            .isEqualTo(first.sessionId());
    }

    @Test
    void revocationOfAllUserSessionsIsIsolatedAndIdempotent() {
        var owner = activeUser();
        var unrelated = activeUser();
        var a = loggedIn(owner, AuthClientType.WEB);
        var b = loggedIn(owner, AuthClientType.MOBILE);
        var c = loggedIn(unrelated, AuthClientType.MOBILE);
        assertThat(refresh.revokeAllForUser(owner.getId(), "ACCOUNT_DEACTIVATED")).isEqualTo(2);
        assertThat(refresh.revokeAllForUser(owner.getId(), "ACCOUNT_DEACTIVATED")).isZero();
        assertThat(sessions.findById(a.sessionId()).orElseThrow().getStatus())
            .isEqualTo(AuthSessionStatus.REVOKED);
        assertThat(sessions.findById(b.sessionId()).orElseThrow().getStatus())
            .isEqualTo(AuthSessionStatus.REVOKED);
        rejects(() -> refresh.rotate(a.refreshToken(), AuthClientType.WEB));
        rejects(() -> refresh.rotate(b.refreshToken(), AuthClientType.MOBILE));
        assertThat(refresh.rotate(c.refreshToken(), AuthClientType.MOBILE).sessionId())
            .isEqualTo(c.sessionId());
        assertThatThrownBy(() -> refresh.revokeAllForUser(owner.getId(), ""))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void inactiveAccountCannotRefreshAndRevokedParentCannotBeReused() {
        var owner = activeUser();
        var admission = loggedIn(owner, AuthClientType.MOBILE);
        // Login updates last_login_at and the @Version column; use a fresh
        // canonical entity rather than the stale pre-login test fixture.
        var latest = users.findById(owner.getId()).orElseThrow();
        org.springframework.test.util.ReflectionTestUtils.setField(latest,
            "accountStatus", AccountStatus.INACTIVE);
        users.saveAndFlush(latest);
        rejects(() -> refresh.rotate(admission.refreshToken(), AuthClientType.MOBILE));
        refresh.revokeAllForUser(owner.getId(), "ACCOUNT_DEACTIVATED");
        rejects(() -> refresh.rotate(admission.refreshToken(), AuthClientType.MOBILE));
        assertThat(sessions.findById(admission.sessionId()).orElseThrow().getStatus())
            .isEqualTo(AuthSessionStatus.REVOKED);
    }
}
