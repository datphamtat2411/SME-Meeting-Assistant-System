package com.sme.meetingassistant.api.meeting.service;

import java.util.UUID;

/** Application boundary used by media features to authorize current meeting access. */
public interface MeetingMediaAccess {
    void requireReadable(UUID meetingId, UUID actorId);
}
