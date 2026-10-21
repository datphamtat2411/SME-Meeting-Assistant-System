package com.sme.meetingassistant.api.userorganization.service;
import java.security.Principal;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;
@Component
public class AuthenticatedUserId {
    public UUID from(Principal principal) {
        if (principal == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        try { return UUID.fromString(principal.getName()); }
        catch (IllegalArgumentException exception) { throw new ResponseStatusException(HttpStatus.UNAUTHORIZED); }
    }
}
