package com.sme.meetingassistant.api.authentication.service;

import com.sme.meetingassistant.api.authentication.entity.AuthClientType;
import com.sme.meetingassistant.api.authentication.entity.AuthSessionEntity;
import com.sme.meetingassistant.api.authentication.entity.AuthSessionStatus;
import com.sme.meetingassistant.api.authentication.entity.RefreshTokenEntity;
import com.sme.meetingassistant.api.authentication.repository.AuthSessionRepository;
import com.sme.meetingassistant.api.authentication.repository.RefreshTokenRepository;
import com.sme.meetingassistant.api.userorganization.entity.AccountStatus;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Transactional core: canonical user lock -> session lock -> refresh token lock.
 * This order matches login admission and prevents parallel refresh, logout and login
 * from racing session state.
 *
 * Importantly, replay/expiry return a rejection value after writing revocation
 * instead of throwing inside the transaction (which would roll back revocation).
 */
@Service
public class RefreshSessionTransaction {
    private static final String REFRESH_REUSE = "REFRESH_REUSE";
    private final UserRepository users;
    private final AuthSessionRepository sessions;
    private final RefreshTokenRepository refreshTokens;
    private final OpaqueRefreshTokenFactory secrets;
    private final JdbcTemplate jdbc;

    public RefreshSessionTransaction(UserRepository users, AuthSessionRepository sessions,
            RefreshTokenRepository refreshTokens, OpaqueRefreshTokenFactory secrets, JdbcTemplate jdbc) {
        this.users = users;
        this.sessions = sessions;
        this.refreshTokens = refreshTokens;
        this.secrets = secrets;
        this.jdbc = jdbc;
    }

    @Transactional
    public RefreshSessionService.RotatedRefresh rotate(String presented, AuthClientType clientType) {
        String hash = secrets.hash(presented);
        // Read only primitive identifiers before locking. Never load an entity which
        // could become stale while waiting on the session/owner pessimistic lock.
        var ids = jdbc.query("""
            SELECT s.user_id, s.id AS session_id FROM refresh_tokens t
            JOIN auth_sessions s ON s.id=t.session_id WHERE t.token_hash=?
            """, (rs, i) -> new TokenOwner(
                rs.getObject("user_id", UUID.class), rs.getObject("session_id", UUID.class)), hash);
        if (ids.size() != 1) return null;
        var owner = ids.getFirst();

        var user = users.findByIdForSessionAdmission(owner.userId()).orElse(null);
        if (user == null) return null;
        AuthSessionEntity session = sessions.findByIdForUpdate(owner.sessionId()).orElse(null);
        if (session == null || !session.getUserId().equals(owner.userId())) return null;
        if (session.getStatus() != AuthSessionStatus.ACTIVE) return null;
        if (user.getAccountStatus() != AccountStatus.ACTIVE || session.getClientType() != clientType) {
            return null;
        }

        RefreshTokenEntity previous = refreshTokens.findByTokenHashForUpdate(hash).orElse(null);
        if (previous == null || !previous.getSessionId().equals(session.getId())) return null;
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);

        // A consumed token is evidence of replay, even if it has since expired.
        if (previous.getConsumedAt() != null || previous.getReplacedByTokenId() != null) {
            revokeFamily(session, now, REFRESH_REUSE);
            jdbc.update("""
                INSERT INTO audit_events(id,occurred_at,actor_user_id,actor_type,
                  action_code,entity_type,entity_id)
                VALUES (?,?,?,'SYSTEM','REFRESH_REPLAY_DETECTED','AUTH_SESSION',?)
                """,UUID.randomUUID(),now,user.getId(),session.getId());
            return null; // the enclosing transaction commits the compromise response
        }
        if (previous.getRevokedAt() != null) return null;

        OffsetDateTime lastActivity = session.getLastSeenAt() == null
            ? session.getCreatedAt() : session.getLastSeenAt();
        if (!now.isBefore(session.getAbsoluteExpiresAt())
                || !now.isBefore(lastActivity.plusDays(7))) {
            session.expire();
            return null; // expiry is persisted even on failure
        }
        if (!now.isBefore(previous.getExpiresAt())) return null;

        var replacementSecret = secrets.issue();
        OffsetDateTime expiresAt = now.plusDays(7);
        if (expiresAt.isAfter(session.getAbsoluteExpiresAt())) {
            expiresAt = session.getAbsoluteExpiresAt();
        }
        RefreshTokenEntity replacement = new RefreshTokenEntity(
            session.getId(), replacementSecret.hash(), now, expiresAt);

        // The FK for replacement lineage requires that the new row exist first.
        // Exactly one new token is inserted; the old token is then consumed once.
        refreshTokens.saveAndFlush(replacement);
        previous.consume(now, replacement.getId());
        session.recordActivity(now);
        refreshTokens.flush();
        sessions.flush();

        return new RefreshSessionService.RotatedRefresh(
            user.getId(), session.getId(), clientType, replacementSecret.raw(),
            expiresAt, session.getAbsoluteExpiresAt());
    }

    @Transactional
    public void revokeCurrent(UUID userId, UUID sessionId) {
        // Same owner lock as login/refresh: a concurrent login cannot escape the
        // serialized revocation of its own matching session.
        if (users.findByIdForSessionAdmission(userId).isEmpty()) return;
        var target = sessions.findByIdForUpdate(sessionId).orElse(null);
        if (target == null || !target.getUserId().equals(userId)) return;
        revokeFamily(target, OffsetDateTime.now(ZoneOffset.UTC), "LOGOUT");
    }

    @Transactional
    public int revokeAllForUser(UUID userId, String reason) {
        if (reason == null || reason.isBlank() || reason.length() > 64) {
            throw new IllegalArgumentException("A stable nonempty revocation reason is required");
        }
        if (users.findByIdForSessionAdmission(userId).isEmpty()) return 0;
        var active = sessions.findByUserIdAndStatusOrderByCreatedAtAsc(
            userId, AuthSessionStatus.ACTIVE);
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        for (var session : active) {
            revokeFamily(session, now, reason);
        }
        return active.size();
    }

    private void revokeFamily(AuthSessionEntity session, OffsetDateTime at, String reason) {
        if (session.getStatus() != AuthSessionStatus.ACTIVE) return;
        session.revoke(at, reason);
        sessions.flush();
        // Preserve consumed/rotation lineage but invalidate all surviving child
        // credentials. Session status is authoritative for old access JWTs too.
        jdbc.update("""
            UPDATE refresh_tokens SET revoked_at=?
             WHERE session_id=? AND revoked_at IS NULL
            """, at, session.getId());
    }

    private record TokenOwner(UUID userId, UUID sessionId) {}
}
