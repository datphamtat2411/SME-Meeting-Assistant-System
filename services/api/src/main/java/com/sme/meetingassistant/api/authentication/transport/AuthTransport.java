package com.sme.meetingassistant.api.authentication.transport;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.time.Duration;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/** Client transport selection never conveys identity or role authorization. */
public final class AuthTransport {
    public static final String ACCESS = "__Host-sme-access";
    public static final String REFRESH = "__Secure-sme-refresh";
    public static final String CSRF = "__Host-sme-csrf";
    public static final String PLATFORM = "X-Auth-Transport";
    private AuthTransport() { }

    public static boolean mobile(HttpServletRequest request) {
        return "mobile".equals(request.getHeader(PLATFORM));
    }

    public static boolean validMobile(HttpServletRequest request) {
        return mobile(request) && request.getHeader(HttpHeaders.ORIGIN) == null
            && request.getHeader(HttpHeaders.REFERER) == null
            && request.getHeader("Sec-Fetch-Site") == null
            && request.getCookies() == null;
    }

    public static String cookie(HttpServletRequest request, String name) {
        Cookie[] cookies = request.getCookies();
        if (cookies == null) return null;
        String found = null;
        for (Cookie c : cookies) {
            if (c.getName().equals(name)) {
                if (found != null) return null; // ambiguous duplicate cookie, fail closed
                found = c.getValue();
            }
        }
        return found;
    }

    public static boolean hasAuthCookies(HttpServletRequest request) {
        return cookie(request, ACCESS) != null || cookie(request, REFRESH) != null;
    }

    public static void setAccess(HttpServletResponse response, String value) {
        add(response, ACCESS, value, "/", Duration.ofMinutes(10), true);
    }

    public static void setRefresh(HttpServletResponse response, String value, Duration ttl) {
        add(response, REFRESH, value, "/api/v1/auth", ttl, true);
    }

    public static void setCsrf(HttpServletResponse response, String value) {
        add(response, CSRF, value, "/", Duration.ofHours(24), false);
    }

    public static void clear(HttpServletResponse response) {
        add(response, ACCESS, "", "/", Duration.ZERO, true);
        add(response, REFRESH, "", "/api/v1/auth", Duration.ZERO, true);
        add(response, CSRF, "", "/", Duration.ZERO, false);
    }

    private static void add(HttpServletResponse response, String name, String value,
            String path, Duration ttl, boolean httpOnly) {
        response.addHeader(HttpHeaders.SET_COOKIE, ResponseCookie.from(name, value)
            .secure(true).httpOnly(httpOnly).sameSite("Lax").path(path)
            .maxAge(ttl.isNegative() ? Duration.ZERO : ttl).build().toString());
    }

    public static ResponseStatusException invalid() {
        return new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid authentication");
    }
}
