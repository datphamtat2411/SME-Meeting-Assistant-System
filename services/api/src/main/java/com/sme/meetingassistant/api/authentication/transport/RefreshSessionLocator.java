package com.sme.meetingassistant.api.authentication.transport;

import com.sme.meetingassistant.api.authentication.service.OpaqueRefreshTokenFactory;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Token-family lookup for Web CSRF and logout.
 *
 * Refresh replay MUST still reach rotation's transaction even when its token
 * was consumed, so identify() intentionally resolves known historical tokens.
 * Logout must never use that historical association as a live credential:
 * identifyUsable() checks the current token, session and account instead.
 */
@Component
public class RefreshSessionLocator {
    private final JdbcTemplate jdbc;
    private final OpaqueRefreshTokenFactory tokens;
    public RefreshSessionLocator(JdbcTemplate jdbc, OpaqueRefreshTokenFactory tokens) {
        this.jdbc = jdbc;
        this.tokens = tokens;
    }

    /** For refresh CSRF only: preserve historical lookup for replay detection. */
    public SessionIdentity identify(String presented) {
        return find(presented, false);
    }

    /**
     * A usable refresh credential may identify the session for logout/CSRF
     * bootstrap. Stale tokens must fall through to verified access JWT or
     * prelogin cleanup; they cannot select another session for revocation.
     */
    public SessionIdentity identifyUsable(String presented) {
        return find(presented, true);
    }

    private SessionIdentity find(String presented, boolean requireUsable) {
        if (presented == null || !presented.matches("[A-Za-z0-9_-]{64}")) return null;
        var rows = jdbc.query("""
            SELECT s.user_id, s.id
              FROM refresh_tokens r
              JOIN auth_sessions s ON s.id=r.session_id
              JOIN users u ON u.id=s.user_id
             WHERE r.token_hash=? AND s.client_type='WEB'
               AND (NOT ? OR (
                   r.consumed_at IS NULL AND r.revoked_at IS NULL
                   AND r.expires_at > CURRENT_TIMESTAMP
                   AND s.status='ACTIVE'
                   AND s.absolute_expires_at > CURRENT_TIMESTAMP
                   AND COALESCE(s.last_seen_at,s.created_at) + INTERVAL '7 days'
                       > CURRENT_TIMESTAMP
                   AND u.account_status='ACTIVE'
               ))
            """, (rs, i) -> new SessionIdentity(
                rs.getObject("user_id", UUID.class), rs.getObject("id", UUID.class)),
            tokens.hash(presented), requireUsable);
        return rows.size() == 1 ? rows.getFirst() : null;
    }

    public record SessionIdentity(UUID userId, UUID sessionId) {}
}
