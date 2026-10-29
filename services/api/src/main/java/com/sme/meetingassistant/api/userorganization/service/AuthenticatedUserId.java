package com.sme.meetingassistant.api.userorganization.service;

import java.util.UUID;

/** Authentication boundary implemented by the trusted server request context, not by client fields. */
public interface AuthenticatedUserId {
    UUID requireUserId();
}
