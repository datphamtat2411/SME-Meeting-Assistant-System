package com.sme.meetingassistant.api.userorganization.service;

import jakarta.servlet.http.HttpServletRequest;
import java.security.Principal;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

/**
 * Fail-closed boundary until the authentication/session pipeline (PR #4/T05) supplies the
 * authenticated request Principal. Never accepts a user-id header, parameter, or bearer claim
 * that has not already been verified by the authentication layer.
 */
@Component
public class ServletAuthenticatedUserId implements AuthenticatedUserId {
    private final HttpServletRequest request;

    public ServletAuthenticatedUserId(HttpServletRequest request) {
        this.request = request;
    }

    @Override
    public UUID requireUserId() {
        Principal principal = request.getUserPrincipal();
        if (principal == null || principal.getName() == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        }
        try {
            return UUID.fromString(principal.getName());
        } catch (IllegalArgumentException invalidPrincipal) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        }
    }
}
