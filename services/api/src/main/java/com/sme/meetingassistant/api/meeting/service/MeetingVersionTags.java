package com.sme.meetingassistant.api.meeting.service;

import com.sme.meetingassistant.api.meeting.entity.MeetingEntity;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/** Per-meeting opaque ETags, independent of JPA's public representation. */
public final class MeetingVersionTags {
    private MeetingVersionTags() {}
    public static String of(MeetingEntity meeting) {
        return "\"m-" + meeting.getId() + "-" + meeting.getVersion() + "\"";
    }
    public static void requireMatch(MeetingEntity meeting, String ifMatch) {
        if (ifMatch == null || ifMatch.isBlank()) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_REQUIRED);
        }
        if (!of(meeting).equals(ifMatch)) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
        }
    }
}
