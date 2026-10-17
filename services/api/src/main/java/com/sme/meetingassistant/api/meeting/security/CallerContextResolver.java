package com.sme.meetingassistant.api.meeting.security;

import java.security.Principal;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

@Component
public class CallerContextResolver {

	public CallerContext resolve(Principal principal) {
		if (principal == null) {
			throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
		}
		try {
			return new CallerContext(UUID.fromString(principal.getName()));
		}
		catch (IllegalArgumentException exception) {
			throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
		}
	}
}
