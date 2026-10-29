package com.sme.meetingassistant.api.authentication.service;

import com.sme.meetingassistant.api.authentication.entity.AuthClientType;
import com.sme.meetingassistant.api.authentication.entity.AuthSessionEntity;
import com.sme.meetingassistant.api.authentication.entity.AuthSessionStatus;
import com.sme.meetingassistant.api.authentication.entity.RefreshTokenEntity;
import com.sme.meetingassistant.api.authentication.repository.AuthSessionRepository;
import com.sme.meetingassistant.api.authentication.repository.RefreshTokenRepository;
import com.sme.meetingassistant.api.userorganization.entity.AccountStatus;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import java.time.Clock;
import java.time.OffsetDateTime;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Separate transaction entry: there must be no UserEntity loaded into this persistence
 * context before the pessimistic row lock. Lock the account to serialize login admission.
 */
@Service
public class SessionAdmissionTransaction {
    private static final int MAX_ACTIVE_SESSIONS = 5;
    private final UserRepository users;
    private final AuthSessionRepository sessions;
    private final RefreshTokenRepository refreshTokens;
    private final OpaqueRefreshTokenFactory tokens;
    private final Clock clock = Clock.systemUTC();

    public SessionAdmissionTransaction(UserRepository users, AuthSessionRepository sessions,
            RefreshTokenRepository refreshTokens, OpaqueRefreshTokenFactory tokens) {
        this.users = users;
        this.sessions = sessions;
        this.refreshTokens = refreshTokens;
        this.tokens = tokens;
    }

    @Transactional
    public LoginAdmissionService.AdmittedLogin admit(
            UUID userId, String verifiedPasswordHash, AuthClientType clientType) {
        var account = users.findByIdForSessionAdmission(userId)
            .orElseThrow(LoginAdmissionService::invalidCredentials);
        if (account.getAccountStatus() != AccountStatus.ACTIVE ||
                !verifiedPasswordHash.equals(account.getPasswordHash())) {
            throw LoginAdmissionService.invalidCredentials();
        }

        OffsetDateTime now = OffsetDateTime.now(clock);
        List<AuthSessionEntity> current = sessions.findByUserIdAndStatusOrderByCreatedAtAsc(
            account.getId(), AuthSessionStatus.ACTIVE);
        for (AuthSessionEntity s : current) {
            OffsetDateTime lastActivity = s.getLastSeenAt() == null
                ? s.getCreatedAt() : s.getLastSeenAt();
            if (!now.isBefore(s.getAbsoluteExpiresAt()) || !now.isBefore(lastActivity.plusDays(7))) {
                s.expire();
            }
        }
        sessions.flush();

        var eligible = current.stream()
            .filter(s -> s.getStatus() == AuthSessionStatus.ACTIVE)
            .sorted(Comparator
                .comparing((AuthSessionEntity s) -> s.getLastSeenAt() == null
                    ? s.getCreatedAt() : s.getLastSeenAt())
                .thenComparing(AuthSessionEntity::getCreatedAt)
                .thenComparing(AuthSessionEntity::getId))
            .toList();
        int evictions = Math.max(0, eligible.size() - (MAX_ACTIVE_SESSIONS - 1));
        for (int i = 0; i < evictions; i++) {
            eligible.get(i).revoke(now, "SESSION_LIMIT");
        }

        AuthSessionEntity session = new AuthSessionEntity(
            account.getId(), clientType, now, now.plusDays(30), null);
        session.recordActivity(now);
        sessions.saveAndFlush(session);

        var secret = tokens.issue();
        OffsetDateTime refreshExpiry = now.plusDays(7);
        refreshTokens.saveAndFlush(new RefreshTokenEntity(
            session.getId(), secret.hash(), now, refreshExpiry));
        account.recordSuccessfulLogin(now);
        users.saveAndFlush(account);

        return new LoginAdmissionService.AdmittedLogin(account.getId(), session.getId(),
            clientType, secret.raw(), refreshExpiry, session.getAbsoluteExpiresAt());
    }
}
