package com.sme.meetingassistant.api.authentication;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.authentication.entity.*;
import com.sme.meetingassistant.api.authentication.repository.*;
import com.sme.meetingassistant.api.authentication.service.*;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.*;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import com.sme.meetingassistant.api.userorganization.setup.*;
import jakarta.persistence.EntityManager;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/** P4-T02 domain integration; the public transport intentionally remains owned by T03/T05. */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
@Transactional
class LoginAdmissionIntegrationTests {
    @Autowired private UserRepository users;
    @Autowired private AuthSessionRepository sessions;
    @Autowired private RefreshTokenRepository refreshTokens;
    @Autowired private LoginAdmissionService login;
    @Autowired private AccountSetupPasswordHasher passwords;
    @Autowired private AccountSetupService setup;
    @Autowired private AccountSetupTokenCodec codec;
    @Autowired private OpaqueRefreshTokenFactory credentials;
    @Autowired private EntityManager entityManager;
    @Autowired private JdbcTemplate jdbc;

    private static final String PASSPHRASE = "Câu mật khẩu Unicode 🔐 đủ dài 2026!";

    private UserEntity pending() {
        return users.saveAndFlush(new UserEntity("login-" + UUID.randomUUID() + "@Example.com",
            "Login Fixture", GlobalRole.EMPLOYEE, null));
    }

    private UserEntity activateByRealSetup() {
        UserEntity account = pending();
        setup.enqueueInitialSetup(account);
        UUID setupId = jdbc.queryForObject(
            "SELECT id FROM account_setup_tokens WHERE user_id = ?", UUID.class, account.getId());
        setup.completeSetup(codec.issue(setupId), PASSPHRASE);
        return account;
    }

    private static void assertUnauthorized(org.junit.jupiter.api.function.Executable operation) {
        assertThatThrownBy(operation::execute)
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(ex -> {
                ResponseStatusException response = (ResponseStatusException) ex;
                assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
                assertThat(response.getReason()).isEqualTo("Invalid credentials");
            });
    }

    @Test
    void completedAccountSetupEnablesUnicodeArgon2idLogin() {
        UserEntity account = activateByRealSetup();
        var result = login.authenticateAndAdmit(
            "  " + account.getEmail().toUpperCase(java.util.Locale.ROOT) + "  ",
            PASSPHRASE, AuthClientType.WEB);

        assertThat(result.userId()).isEqualTo(account.getId());
        assertThat(result.clientType()).isEqualTo(AuthClientType.WEB);
        assertThat(result.sessionId()).isNotNull();
        assertThat(result.refreshToken()).hasSizeGreaterThan(60);
        assertThat(result.refreshExpiresAt()).isAfter(OffsetDateTime.now(ZoneOffset.UTC).plusDays(6));
        AuthSessionEntity session = sessions.findById(result.sessionId()).orElseThrow();
        assertThat(session.getStatus()).isEqualTo(AuthSessionStatus.ACTIVE);
        assertThat(session.getLastSeenAt()).isNotNull();
        assertThat(session.getUserId()).isEqualTo(account.getId());
        assertThat(session.getClientType()).isEqualTo(AuthClientType.WEB);
        assertThat(session.getAbsoluteExpiresAt()).isEqualTo(session.getCreatedAt().plusDays(30));
        assertThat(sessions.countByUserIdAndStatus(account.getId(), AuthSessionStatus.ACTIVE))
            .isEqualTo(1);

        var stored = refreshTokens.findBySessionIdOrderByIssuedAtAsc(result.sessionId());
        assertThat(stored).hasSize(1);
        assertThat(stored.getFirst().getTokenHash()).isEqualTo(credentials.hash(result.refreshToken()));
        assertThat(stored.getFirst().getTokenHash()).doesNotContain(result.refreshToken());
        assertThat(stored.getFirst().getExpiresAt()).isEqualTo(result.refreshExpiresAt());
        assertThat(users.findById(account.getId()).orElseThrow().getLastLoginAt()).isNotNull();
    }

    @Test
    void invalidPasswordUnknownEmailPendingAndInactiveHaveUniformPublicFailure() {
        UserEntity active = activateByRealSetup();
        UserEntity pendingAccount = pending();
        UserEntity inactive = activateByRealSetup();
        ReflectionTestUtils.setField(inactive, "accountStatus", AccountStatus.INACTIVE);
        users.saveAndFlush(inactive);
        entityManager.flush();

        assertUnauthorized(() -> login.authenticateAndAdmit(
            active.getEmail(), "Incorrect but sufficiently long password", AuthClientType.MOBILE));
        assertUnauthorized(() -> login.authenticateAndAdmit(
            "does-not-exist-" + UUID.randomUUID() + "@example.com", PASSPHRASE, AuthClientType.MOBILE));
        assertUnauthorized(() -> login.authenticateAndAdmit(
            pendingAccount.getEmail(), PASSPHRASE, AuthClientType.MOBILE));
        assertUnauthorized(() -> login.authenticateAndAdmit(
            inactive.getEmail(), PASSPHRASE, AuthClientType.MOBILE));
        assertThat(sessions.countByUserIdAndStatus(active.getId(), AuthSessionStatus.ACTIVE)).isZero();
        assertThat(sessions.countByUserIdAndStatus(inactive.getId(), AuthSessionStatus.ACTIVE)).isZero();
        assertThat(sessions.countByUserIdAndStatus(pendingAccount.getId(), AuthSessionStatus.ACTIVE)).isZero();
    }

    @Test
    void rejectsMissingAndOversizedCredentialsWithoutCreatingSession() {
        UserEntity account = activateByRealSetup();
        assertUnauthorized(() -> login.authenticateAndAdmit(null, PASSPHRASE, AuthClientType.WEB));
        assertUnauthorized(() -> login.authenticateAndAdmit(account.getEmail(), "", AuthClientType.WEB));
        assertUnauthorized(() -> login.authenticateAndAdmit(account.getEmail(), "a".repeat(1025), AuthClientType.WEB));
        assertUnauthorized(() -> login.authenticateAndAdmit("a".repeat(321), PASSPHRASE, AuthClientType.WEB));
        assertThat(sessions.countByUserIdAndStatus(account.getId(), AuthSessionStatus.ACTIVE)).isZero();
    }

    @Test
    void eachLoginCreatesDifferentSessionAndOpaqueRefreshSecret() {
        UserEntity account = activateByRealSetup();
        var first = login.authenticateAndAdmit(account.getEmail(), PASSPHRASE, AuthClientType.WEB);
        var second = login.authenticateAndAdmit(account.getEmail(), PASSPHRASE, AuthClientType.MOBILE);
        assertThat(first.sessionId()).isNotEqualTo(second.sessionId());
        assertThat(first.refreshToken()).isNotEqualTo(second.refreshToken());
        assertThat(credentials.hash(first.refreshToken())).isNotEqualTo(credentials.hash(second.refreshToken()));
        assertThat(sessions.countByUserIdAndStatus(account.getId(), AuthSessionStatus.ACTIVE)).isEqualTo(2);
        assertThat(refreshTokens.findBySessionIdOrderByIssuedAtAsc(first.sessionId())).hasSize(1);
        assertThat(refreshTokens.findBySessionIdOrderByIssuedAtAsc(second.sessionId())).hasSize(1);
    }

    @Test
    void sixthLoginRevokesTheDeterministicallyOldestSessionOnly() {
        UserEntity account = activateByRealSetup();
        var ids = new java.util.ArrayList<UUID>();
        for (int i = 0; i < 5; i++) {
            ids.add(login.authenticateAndAdmit(account.getEmail(), PASSPHRASE, AuthClientType.WEB)
                .sessionId());
        }
        assertThat(sessions.countByUserIdAndStatus(account.getId(), AuthSessionStatus.ACTIVE)).isEqualTo(5);
        var sixth = login.authenticateAndAdmit(account.getEmail(), PASSPHRASE, AuthClientType.WEB);

        assertThat(sessions.countByUserIdAndStatus(account.getId(), AuthSessionStatus.ACTIVE)).isEqualTo(5);
        assertThat(sessions.findById(ids.getFirst()).orElseThrow().getStatus())
            .isEqualTo(AuthSessionStatus.REVOKED);
        assertThat(sessions.findById(ids.getFirst()).orElseThrow().getRevokeReason())
            .isEqualTo("SESSION_LIMIT");
        for (int i = 1; i < 5; i++) {
            assertThat(sessions.findById(ids.get(i)).orElseThrow().getStatus())
                .isEqualTo(AuthSessionStatus.ACTIVE);
        }
        assertThat(sessions.findById(sixth.sessionId()).orElseThrow().getStatus())
            .isEqualTo(AuthSessionStatus.ACTIVE);
        assertThat(refreshTokens.findBySessionIdOrderByIssuedAtAsc(ids.getFirst())).hasSize(1);
    }

    @Test
    void staleSessionsAreExpiredBeforeCountingTowardTheLimit() {
        UserEntity account = activateByRealSetup();
        var first = login.authenticateAndAdmit(account.getEmail(), PASSPHRASE, AuthClientType.WEB);
        jdbc.update("UPDATE auth_sessions SET last_seen_at = now() - INTERVAL '8 days' WHERE id = ?",
            first.sessionId());
        entityManager.clear();
        login.authenticateAndAdmit(account.getEmail(), PASSPHRASE, AuthClientType.WEB);
        assertThat(sessions.findById(first.sessionId()).orElseThrow().getStatus())
            .isEqualTo(AuthSessionStatus.EXPIRED);
        assertThat(sessions.countByUserIdAndStatus(account.getId(), AuthSessionStatus.ACTIVE)).isEqualTo(1);
    }

    @Test
    void passwordChangeAndAccountDeactivationAreNotImplicitlyBypassed() {
        UserEntity account = activateByRealSetup();
        login.authenticateAndAdmit(account.getEmail(), PASSPHRASE, AuthClientType.MOBILE);
        // A future transport must check current account/session on every request (P4-T03).
        ReflectionTestUtils.setField(account, "accountStatus", AccountStatus.INACTIVE);
        users.saveAndFlush(account);
        assertUnauthorized(() -> login.authenticateAndAdmit(
            account.getEmail(), PASSPHRASE, AuthClientType.MOBILE));
        assertThat(sessions.countByUserIdAndStatus(account.getId(), AuthSessionStatus.ACTIVE)).isEqualTo(1);
        // Existing sessions are revoked when PR #3 T05 is integrated; not silently done here.
    }

    @Test
    void mismatchedLegacyVerifierIsNotAcceptedOrUpgradedSilently() {
        UserEntity account = activateByRealSetup();
        ReflectionTestUtils.setField(account, "passwordHash", "$2a$12$legacybcryptdummy");
        users.saveAndFlush(account);
        assertUnauthorized(() -> login.authenticateAndAdmit(
            account.getEmail(), PASSPHRASE, AuthClientType.WEB));
        assertThat(sessions.countByUserIdAndStatus(account.getId(), AuthSessionStatus.ACTIVE)).isZero();
    }
}
