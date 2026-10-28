package com.sme.meetingassistant.api.authentication.transport;

import com.sme.meetingassistant.api.authentication.service.OpaqueRefreshTokenFactory;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** Lookup solely for session-bound CSRF and Web logout, not authorization by itself. */
@Component
public class RefreshSessionLocator {
    private final JdbcTemplate jdbc;
    private final OpaqueRefreshTokenFactory tokens;
    public RefreshSessionLocator(JdbcTemplate jdbc, OpaqueRefreshTokenFactory tokens) {
        this.jdbc = jdbc;
        this.tokens = tokens;
    }

    public SessionIdentity identify(String presented) {
        if (presented == null || !presented.matches("[A-Za-z0-9_-]{64}")) return null;
        var rows = jdbc.query("""
            SELECT s.user_id, s.id FROM refresh_tokens r JOIN auth_sessions s
              ON s.id=r.session_id WHERE r.token_hash=? AND s.client_type='WEB'
            """, (rs, i) -> new SessionIdentity(
                rs.getObject("user_id", UUID.class), rs.getObject("id", UUID.class)),
            tokens.hash(presented));
        return rows.size() == 1 ? rows.getFirst() : null;
    }

    public record SessionIdentity(UUID userId, UUID sessionId) {}
}
