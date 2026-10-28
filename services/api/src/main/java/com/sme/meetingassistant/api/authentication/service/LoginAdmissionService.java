package com.sme.meetingassistant.api.authentication.service;

import com.sme.meetingassistant.api.authentication.entity.AuthClientType;
import com.sme.meetingassistant.api.authentication.entity.AuthSessionEntity;
import com.sme.meetingassistant.api.authentication.entity.AuthSessionStatus;
import com.sme.meetingassistant.api.authentication.entity.RefreshTokenEntity;
import com.sme.meetingassistant.api.authentication.repository.AuthSessionRepository;
import com.sme.meetingassistant.api.authentication.repository.RefreshTokenRepository;
import com.sme.meetingassistant.api.userorganization.entity.AccountStatus;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import com.sme.meetingassistant.api.userorganization.service.EmailNormalizer;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupPasswordHasher;
import jakarta.persistence.EntityManager;
import java.time.Clock;
import java.time.OffsetDateTime;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Trusted internal login domain, deliberately NOT exposed as an unauthenticated endpoint
 * until RS256 access tokens, Web CSRF/cookies, mobile transport and abuse defenses exist.
 *
 * Password verification occurs before acquiring the account row lock. The locked row is
 * rechecked before admission, so concurrent password resets/deactivation cannot authenticate
 * stale credentials. One account lock serializes concurrent session-count decisions.
 */
@Service
public class LoginAdmissionService {
    private static final int MAX_ACTIVE_SESSIONS = 5;
    private final UserRepository users;
    private final EntityManager entityManager;
    private final AuthSessionRepository sessions;
    private final RefreshTokenRepository refreshTokens;
    private final AccountSetupPasswordHasher passwords;
    private final OpaqueRefreshTokenFactory tokenFactory;
    private final Clock clock;
    private final String dummyVerifier;

    @Autowired
    public LoginAdmissionService(UserRepository users, EntityManager entityManager, AuthSessionRepository sessions,
            RefreshTokenRepository refreshTokens, AccountSetupPasswordHasher passwords,
            OpaqueRefreshTokenFactory tokenFactory) {
        this(users, entityManager, sessions, refreshTokens, passwords, tokenFactory, Clock.systemUTC());
    }

    /** Package-local seam for deterministic domain tests; production always uses UTC system time. */
    LoginAdmissionService(UserRepository users, EntityManager entityManager, AuthSessionRepository sessions,
            RefreshTokenRepository refreshTokens, AccountSetupPasswordHasher passwords,
            OpaqueRefreshTokenFactory tokenFactory, Clock clock) {
        this.users = users;
        this.entityManager = entityManager;
        this.sessions = sessions;
        this.refreshTokens = refreshTokens;
        this.passwords = passwords;
        this.tokenFactory = tokenFactory;
        this.clock = clock;
        this.dummyVerifier = passwords.hash("irrelevant-dummy-credential-with-sufficient-length");
    }

    /**
     * The client type comes from a trusted transport adapter, never an authorization claim
     * from a request body. Returned raw token stays inside the future transport boundary.
     */
    @Transactional
    public AdmittedLogin authenticateAndAdmit(String email, String password, AuthClientType clientType) {
        Objects.requireNonNull(clientType, "trusted clientType");
        if (email == null || email.isBlank() || email.length() > 320 ||
                password == null || password.isEmpty() || password.length() > 1024) {
            throw invalidCredentials();
        }
        String normalized = EmailNormalizer.normalize(email);
        var candidate = users.findByEmailNormalized(normalized);
        String verifier = candidate.filter(u -> u.getAccountStatus() == AccountStatus.ACTIVE)
            .map(u -> u.getPasswordHash())
            .filter(hash -> hash != null && hash.startsWith("$argon2id$"))
            .orElse(dummyVerifier);

        boolean valid;
        try {
            valid = passwords.matches(password, verifier);
        } catch (RuntimeException malformedHash) {
            valid = false;
        }
        if (!valid || candidate.isEmpty() || candidate.get().getAccountStatus() != AccountStatus.ACTIVE
                || !verifier.equals(candidate.get().getPasswordHash())) {
            throw invalidCredentials();
        }

        var actor = users.findByIdForSessionAdmission(candidate.get().getId())
            .orElseThrow(LoginAdmissionService::invalidCredentials);
        // A managed entity initially read before the lock may be stale. Refresh under
        // the row lock so concurrent reset/deactivation cannot authenticate old state.
        entityManager.refresh(actor);
        if (actor.getAccountStatus() != AccountStatus.ACTIVE ||
                !verifier.equals(actor.getPasswordHash())) {
            throw invalidCredentials();
        }

        OffsetDateTime now = OffsetDateTime.now(clock);
        List<AuthSessionEntity> live = sessions.findByUserIdAndStatusOrderByCreatedAtAsc(
            actor.getId(), AuthSessionStatus.ACTIVE);
        for (AuthSessionEntity session : live) {
            OffsetDateTime mostRecent = session.getLastSeenAt() == null
                ? session.getCreatedAt() : session.getLastSeenAt();
            if (!now.isBefore(session.getAbsoluteExpiresAt()) ||
                    !now.isBefore(mostRecent.plusDays(7))) {
                session.expire();
            }
        }
        sessions.flush();

        List<AuthSessionEntity> remaining = live.stream()
            .filter(session -> session.getStatus() == AuthSessionStatus.ACTIVE)
            .sorted(Comparator
                .comparing((AuthSessionEntity session) -> session.getLastSeenAt() == null
                    ? session.getCreatedAt() : session.getLastSeenAt())
                .thenComparing(AuthSessionEntity::getCreatedAt)
                .thenComparing(AuthSessionEntity::getId))
            .toList();
        // Keep at most four pre-existing sessions before admitting the fifth.
        int excess = Math.max(0, remaining.size() - (MAX_ACTIVE_SESSIONS - 1));
        for (int i = 0; i < excess; i++) {
            remaining.get(i).revoke(now, "SESSION_LIMIT");
        }

        AuthSessionEntity session = new AuthSessionEntity(
            actor.getId(), clientType, now, now.plusDays(30), null);
        session.recordActivity(now);
        sessions.saveAndFlush(session);
        OpaqueRefreshTokenFactory.IssuedRefreshToken secret = tokenFactory.issue();
        OffsetDateTime tokenExpiresAt = now.plusDays(7);
        refreshTokens.saveAndFlush(new RefreshTokenEntity(
            session.getId(), secret.hash(), now, tokenExpiresAt));
        actor.recordSuccessfulLogin(now);
        users.saveAndFlush(actor);

        return new AdmittedLogin(actor.getId(), session.getId(), clientType,
            secret.raw(), tokenExpiresAt, session.getAbsoluteExpiresAt());
    }

    private static ResponseStatusException invalidCredentials() {
        return new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid credentials");
    }

    /**
     * Internal result, not an API response object. Web must not serialize refresh credentials;
     * P4-T03/T05 own access-token issuance and approved client transport.
     */
    public record AdmittedLogin(UUID userId, UUID sessionId, AuthClientType clientType,
                                String refreshToken, OffsetDateTime refreshExpiresAt,
                                OffsetDateTime absoluteSessionExpiresAt) {}
}
