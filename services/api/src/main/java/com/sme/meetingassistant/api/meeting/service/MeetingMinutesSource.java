package com.sme.meetingassistant.api.meeting.service;

import com.sme.meetingassistant.api.meeting.dto.MeetingView;
import java.util.UUID;

/** Meeting-owned, currently authorized read boundary for canonical Minutes. */
public interface MeetingMinutesSource {
    MeetingView authorizedMeeting(UUID meetingId);
}
