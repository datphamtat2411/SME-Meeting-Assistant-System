package com.sme.meetingassistant.api.authentication.transport;

import com.sme.meetingassistant.api.config.HttpSecurityProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.URI;
import java.util.Set;
import org.springframework.http.HttpHeaders;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Additional session-bound proof and exact Origin/Referer checking on cookie/Web writes.
 * Standard Spring CsrfFilter enforces the cookie/header equality independently.
 */
public final class BrowserCsrfProtectionFilter extends OncePerRequestFilter {
    private static final Set<String> SAFE = Set.of("GET", "HEAD", "OPTIONS", "TRACE");
    private final SessionCsrfTokens tokens;
    private final RefreshSessionLocator locator;
    private final Set<String> trustedOrigins;
    private final AuthSecurityFailureHandler failures;

    public BrowserCsrfProtectionFilter(SessionCsrfTokens tokens, RefreshSessionLocator locator,
            HttpSecurityProperties properties, AuthSecurityFailureHandler failures) {
        this.tokens = tokens;
        this.locator = locator;
        this.trustedOrigins = Set.copyOf(properties.getCors().getAllowedOrigins());
        this.failures = failures;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res,
            FilterChain chain) throws ServletException, IOException {
        if (SAFE.contains(req.getMethod()) || !req.getRequestURI().startsWith("/api/v1/")) {
            chain.doFilter(req, res);
            return;
        }
        if (req.getRequestURI().equals("/api/v1/auth/account-setup")) {
            chain.doFilter(req, res); // no browser-authenticated session in initial setup
            return;
        }

        if (AuthTransport.mobile(req)) {
            if (!AuthTransport.validMobile(req)) {
                failures.forbidden(res);
                return;
            }
            chain.doFilter(req, res);
            return;
        }

        boolean authRoute = req.getRequestURI().equals("/api/v1/auth/login")
            || req.getRequestURI().equals("/api/v1/auth/refresh")
            || req.getRequestURI().equals("/api/v1/auth/logout");
        boolean browser = authRoute || AuthTransport.hasAuthCookies(req)
            || req.getHeader(HttpHeaders.ORIGIN) != null;
        if (!browser) {
            chain.doFilter(req, res);
            return;
        }
        if (!validOrigin(req)) {
            failures.forbidden(res);
            return;
        }
        String binding;
        if (req.getRequestURI().equals("/api/v1/auth/login")) {
            binding = "prelogin";
        } else if (req.getRequestURI().equals("/api/v1/auth/refresh") ||
                req.getRequestURI().equals("/api/v1/auth/logout")) {
            var identity = locator.identify(AuthTransport.cookie(req, AuthTransport.REFRESH));
            binding = identity == null ? null : identity.sessionId().toString();
        } else {
            Authentication auth = SecurityContextHolder.getContext().getAuthentication();
            binding = auth instanceof JwtAuthenticationToken jwt
                ? jwt.getToken().getClaimAsString("sid") : null;
        }
        if (!tokens.valid(binding, AuthTransport.cookie(req, AuthTransport.CSRF),
                req.getHeader("X-CSRF-Token"))) {
            failures.forbidden(res);
            return;
        }
        chain.doFilter(req, res);
    }

    private boolean validOrigin(HttpServletRequest req) {
        if ("cross-site".equalsIgnoreCase(req.getHeader("Sec-Fetch-Site"))) return false;
        String origin = req.getHeader(HttpHeaders.ORIGIN);
        if (origin == null) {
            String referer = req.getHeader(HttpHeaders.REFERER);
            if (referer == null) return false;
            try {
                URI uri = URI.create(referer);
                if (uri.getHost() == null || uri.getUserInfo() != null) return false;
                origin = uri.getScheme() + "://" + uri.getHost()
                    + (uri.getPort() < 0 ? "" : ":" + uri.getPort());
            } catch (Exception invalid) {
                return false;
            }
        }
        return trustedOrigins.contains(origin);
    }
}
