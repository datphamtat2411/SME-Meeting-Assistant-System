package com.sme.meetingassistant.api.authentication.transport;

import com.sme.meetingassistant.api.authentication.entity.AuthClientType;
import com.sme.meetingassistant.api.authentication.abuse.AuthAbuseGuard;
import com.sme.meetingassistant.api.authentication.abuse.AuthSecurityEventRecorder;
import com.sme.meetingassistant.api.authentication.security.Rs256AccessTokenService;
import com.sme.meetingassistant.api.authentication.service.LoginAdmissionService;
import com.sme.meetingassistant.api.authentication.service.RefreshSessionService;
import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.bind.annotation.*;

/**
 * Shared logical login/refresh/logout actions. Disabled until P4-T07 rate limits and
 * abuse monitoring are installed; tests explicitly enable this transport.
 * No Web bearer secrets in JSON. Mobile bearer values are explicit mobile-only DTOs.
 */
@RestController
@RequestMapping("/api/v1/auth")
@ConditionalOnProperty(prefix = "app.auth.transport", name = "enabled", havingValue = "true")
public class AuthHttpController {
    private final AuthAbuseGuard abuse;
    private final LoginAdmissionService login;
    private final RefreshSessionService refresh;
    private final Rs256AccessTokenService jwt;
    private final SessionCsrfTokens csrf;
    private final WebLogoutIdentityResolver logoutIdentity;
    private final ApiResponseFactory responses;

    public AuthHttpController(LoginAdmissionService login, RefreshSessionService refresh,
            Rs256AccessTokenService jwt, SessionCsrfTokens csrf, WebLogoutIdentityResolver logoutIdentity,
            ApiResponseFactory responses, AuthAbuseGuard abuse) {
        this.login = login;
        this.abuse = abuse;
        this.refresh = refresh;
        this.jwt = jwt;
        this.csrf = csrf;
        this.logoutIdentity = logoutIdentity;
        this.responses = responses;
    }

    public record LoginRequest(@NotBlank @Email String email, @NotBlank String password) {}
    public record BrowserSession(String sessionStatus, String csrfToken) {}
    public record MobileTokens(String accessToken, String refreshToken,
                               String tokenType, long expiresIn) {}
    public record CsrfBootstrap(String csrfToken) {}

    @GetMapping("/csrf")
    public ResponseEntity<ApiResponse<CsrfBootstrap>> csrf(HttpServletRequest request,
            HttpServletResponse response) {
        String binding = "prelogin";
        var identity = logoutIdentity.identify(request);
        if (identity != null) binding = identity.sessionId().toString();
        String value = csrf.issue(binding);
        AuthTransport.setCsrf(response, value);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(responses.success(new CsrfBootstrap(value)));
    }

    @PostMapping("/login")
    public ResponseEntity<? extends ApiResponse<?>> login(@Valid @RequestBody LoginRequest payload,
            HttpServletRequest request, HttpServletResponse response) {
        boolean mobile = AuthTransport.mobile(request);
        if (mobile && !AuthTransport.validMobile(request)) throw AuthTransport.invalid();
        if (!mobile && request.getHeader(HttpHeaders.AUTHORIZATION) != null) throw AuthTransport.invalid();
        // Enforce the rolling source cap and pair backoff BEFORE Argon2id.
        var admission = abuse.loginAdmission(request, payload.email());
        LoginAdmissionService.AdmittedLogin admitted;
        try {
            admitted = login.authenticateAndAdmit(payload.email(), payload.password(),
                mobile ? AuthClientType.MOBILE : AuthClientType.WEB);
        } catch (org.springframework.web.server.ResponseStatusException rejected) {
            abuse.loginFailed(admission);
            throw rejected;
        }
        abuse.loginSucceeded(admission, admitted.userId());
        String access = jwt.issue(admitted.userId(), admitted.sessionId());
        if (mobile) {
            return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(responses.success(new MobileTokens(access, admitted.refreshToken(), "Bearer", 600)));
        }
        AuthTransport.setAccess(response, access,
            Duration.between(OffsetDateTime.now(ZoneOffset.UTC),
                admitted.absoluteSessionExpiresAt()));
        AuthTransport.setRefresh(response, admitted.refreshToken(),
            Duration.between(OffsetDateTime.now(ZoneOffset.UTC), admitted.refreshExpiresAt()));
        String signedCsrf = csrf.issue(admitted.sessionId().toString());
        AuthTransport.setCsrf(response, signedCsrf);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(responses.success(new BrowserSession("ACTIVE", signedCsrf)));
    }

    @PostMapping("/refresh")
    public ResponseEntity<? extends ApiResponse<?>> refresh(HttpServletRequest request,
            HttpServletResponse response) {
        boolean mobile = AuthTransport.mobile(request);
        if (mobile && !AuthTransport.validMobile(request)) throw AuthTransport.invalid();
        String presented = mobile
            ? mobileRefreshHeader(request.getHeader(HttpHeaders.AUTHORIZATION))
            : AuthTransport.cookie(request, AuthTransport.REFRESH);
        // Throttle guessing/replay before token hashing, DB locks and rotation.
        var refreshAdmission = abuse.refreshAdmission(request, presented);
        RefreshSessionService.RotatedRefresh rotated;
        try {
            rotated = refresh.rotate(presented,
                mobile ? AuthClientType.MOBILE : AuthClientType.WEB);
        } catch (org.springframework.web.server.ResponseStatusException rejected) {
            abuse.refreshOutcome(refreshAdmission, null, false);
            throw rejected;
        }
        abuse.refreshOutcome(refreshAdmission, rotated.userId(), true);
        String access = jwt.issue(rotated.userId(), rotated.sessionId());
        if (mobile) {
            return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(responses.success(new MobileTokens(access, rotated.refreshToken(), "Bearer", 600)));
        }
        AuthTransport.setAccess(response, access,
            Duration.between(OffsetDateTime.now(ZoneOffset.UTC),
                rotated.absoluteSessionExpiresAt()));
        AuthTransport.setRefresh(response, rotated.refreshToken(),
            Duration.between(OffsetDateTime.now(ZoneOffset.UTC), rotated.refreshExpiresAt()));
        String signedCsrf = csrf.issue(rotated.sessionId().toString());
        AuthTransport.setCsrf(response, signedCsrf);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(responses.success(new BrowserSession("ACTIVE", signedCsrf)));
    }

    @PostMapping("/logout")
    public ResponseEntity<ApiResponse<Void>> logout(HttpServletRequest request,
            HttpServletResponse response, Authentication authentication) {
        boolean mobile = AuthTransport.mobile(request);
        if (mobile) {
            if (!AuthTransport.validMobile(request) ||
                    !(authentication instanceof JwtAuthenticationToken jwtAuth))
                throw AuthTransport.invalid();
            java.util.UUID currentUser = java.util.UUID.fromString(jwtAuth.getToken().getSubject());
            refresh.logout(currentUser,
                java.util.UUID.fromString(jwtAuth.getToken().getClaimAsString("sid")));
            abuse.logEvent(AuthSecurityEventRecorder.Action.SESSION_LOGGED_OUT, currentUser, request);
        } else {
            var current = logoutIdentity.identify(request);
            if (current != null) {
                refresh.logout(current.userId(), current.sessionId());
                abuse.logEvent(AuthSecurityEventRecorder.Action.SESSION_LOGGED_OUT,
                    current.userId(), request);
            }
            AuthTransport.clear(response);
        }
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(responses.success(null));
    }

    private static String mobileRefreshHeader(String raw) {
        if (raw == null || !raw.startsWith("Bearer ") ||
                raw.substring(7).indexOf(' ') >= 0) throw AuthTransport.invalid();
        return raw.substring(7);
    }
}
