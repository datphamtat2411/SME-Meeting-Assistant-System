package com.sme.meetingassistant.api.userorganization.service;

import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/** Opaque HTTP preconditions; no public field exposes JPA's version column. */
public final class UserVersionTags {
    private UserVersionTags() {}

    public static String forUser(UserEntity user) {
        return forUser(user.getId(), user.getVersion());
    }

    public static String forUser(UUID id, long version) {
        return "\"u-" + id + "-" + version + "\"";
    }

    public static void requireMatch(UserEntity user, String ifMatch) {
        if (ifMatch == null || ifMatch.isBlank()) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_REQUIRED);
        }
        if (!ifMatch.equals(forUser(user))) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
        }
    }
}
