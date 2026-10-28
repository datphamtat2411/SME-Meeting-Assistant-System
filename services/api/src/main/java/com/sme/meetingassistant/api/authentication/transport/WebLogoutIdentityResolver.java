package com.sme.meetingassistant.api.authentication.transport;

import jakarta.servlet.http.HttpServletRequest;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.stereotype.Component;

/**
 * Resolve a Web logout session from the refresh cookie or an independently
 * VERIFIED, still-live Web access JWT. Never use unverified JWT claims or
 * client-provided identities to revoke a server-side session.
 *
 * Missing/expired/unknown credentials result in no server revocation; the
 * caller may still clear browser cookies with prelogin CSRF and trusted Origin.
 * The normal resource-server bearer resolver deliberately ignores Web logout,
 * so an expired access cookie must never prevent that local cleanup.
 */
@Component
@ConditionalOnProperty(prefix = "app.auth.transport", name = "enabled", havingValue = "true")
public class WebLogoutIdentityResolver {
    private final RefreshSessionLocator refresh;
    private final JwtDecoder jwtDecoder;
    private final JdbcTemplate jdbc;

    public WebLogoutIdentityResolver(RefreshSessionLocator refresh,
            JwtDecoder jwtDecoder, JdbcTemplate jdbc) {
        this.refresh = refresh;
        this.jwtDecoder = jwtDecoder;
        this.jdbc = jdbc;
    }

    public RefreshSessionLocator.SessionIdentity identify(HttpServletRequest request) {
        var viaRefresh = refresh.identify(AuthTransport.cookie(request, AuthTransport.REFRESH));
        if (viaRefresh != null) return viaRefresh;

        String rawAccess = AuthTransport.cookie(request, AuthTransport.ACCESS);
        if (rawAccess == null || rawAccess.isBlank()) return null;
        try {
            Jwt verified = jwtDecoder.decode(rawAccess);
            UUID userId = UUID.fromString(verified.getSubject());
            UUID sessionId = UUID.fromString(verified.getClaimAsString("sid"));
            // The shared JWT decoder verifies signature, issuer, audience,
            // temporal claims and live user/session. Require WEB ownership too.
            Integer webSessions = jdbc.queryForObject("""
                SELECT count(*) FROM auth_sessions
                WHERE id=? AND user_id=? AND status='ACTIVE' AND client_type='WEB'
                """, Integer.class, sessionId, userId);
            return webSessions != null && webSessions == 1
                ? new RefreshSessionLocator.SessionIdentity(userId, sessionId) : null;
        } catch (JwtException | IllegalArgumentException invalid) {
            return null;
        }
    }
}
