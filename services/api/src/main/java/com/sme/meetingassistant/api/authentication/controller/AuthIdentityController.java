package com.sme.meetingassistant.api.authentication.controller;

import com.sme.meetingassistant.api.authentication.service.AuthIdentityContextService;
import com.sme.meetingassistant.api.authentication.service.AuthIdentityContextService.AuthContext;
import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import org.springframework.http.CacheControl;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * API-EP-AUTH-004: authenticated identity and current session context for clients.
 * The profile editing endpoint remains /api/v1/me/profile (PR #3 T03).
 */
@RestController
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
@RequestMapping("/api/v1/auth")
public class AuthIdentityController {
    private final AuthIdentityContextService identities;
    private final ApiResponseFactory responses;

    public AuthIdentityController(AuthIdentityContextService identities,
            ApiResponseFactory responses) {
        this.identities = identities;
        this.responses = responses;
    }

    @GetMapping("/me")
    public ResponseEntity<ApiResponse<AuthContext>> me(Authentication authentication) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(responses.success(identities.current(authentication)));
    }
}
