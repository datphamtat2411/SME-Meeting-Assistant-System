package com.sme.meetingassistant.api.authentication.security;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;

/** Current DB session/account status always overrides valid JWT claims. */
@Component
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
public class SessionAuthority {
    private final JdbcTemplate jdbc;
    public SessionAuthority(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public boolean isLive(UUID userId, UUID sessionId) {
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        var found = jdbc.query("""
            SELECT s.created_at,s.last_seen_at,s.absolute_expires_at
              FROM auth_sessions s JOIN users u ON u.id=s.user_id
             WHERE s.id=? AND s.user_id=? AND s.status='ACTIVE'
               AND u.account_status='ACTIVE'
            """, (rs, i) -> new Activity(
                rs.getObject("created_at", OffsetDateTime.class),
                rs.getObject("last_seen_at", OffsetDateTime.class),
                rs.getObject("absolute_expires_at", OffsetDateTime.class)), sessionId, userId);
        if (found.size() != 1) return false;
        var session = found.getFirst();
        OffsetDateTime last = session.lastSeen() == null ? session.created() : session.lastSeen();
        if (!now.isBefore(session.expires()) || !now.isBefore(last.plusDays(7))) return false;
        // Rate-controlled session activity write; no durable token/user data in logs.
        jdbc.update("""
            UPDATE auth_sessions SET last_seen_at=?
             WHERE id=? AND status='ACTIVE' AND
               (last_seen_at IS NULL OR last_seen_at < ?)
            """, now, sessionId, now.minusMinutes(5));
        return true;
    }

    private record Activity(OffsetDateTime created, OffsetDateTime lastSeen, OffsetDateTime expires) {}
}
