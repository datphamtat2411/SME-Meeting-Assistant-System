package com.sme.meetingassistant.api.userorganization.service;

import java.security.Principal;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

/**
 * Fail-closed boundary until the authentication/session pipeline (PR #4/T05) supplies
 * a verified request Principal. The singleton resolves identity only inside an HTTP
 * request, so non-web contexts can initialize without a servlet request bean.
 */
@Component
public class ServletAuthenticatedUserId implements AuthenticatedUserId {

    @Override
    public UUID requireUserId() {
        if (!(RequestContextHolder.getRequestAttributes() instanceof ServletRequestAttributes attributes)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        }
        Principal principal = attributes.getRequest().getUserPrincipal();
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
