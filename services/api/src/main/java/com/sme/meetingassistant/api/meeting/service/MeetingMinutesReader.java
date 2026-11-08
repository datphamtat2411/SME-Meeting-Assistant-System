package com.sme.meetingassistant.api.meeting.service;

import com.sme.meetingassistant.api.meeting.dto.MeetingView;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class MeetingMinutesReader implements MeetingMinutesSource {
    private final MeetingCoreService core;

    public MeetingMinutesReader(MeetingCoreService core) {
        this.core = core;
    }

    @Override
    @Transactional(readOnly = true)
    public MeetingView authorizedMeeting(UUID meetingId) {
        // Reuse the authoritative current active-account + organizer / active
        // participant checks; neither an Action Item assignment nor Admin role
        // grants meeting-content read access.
        return MeetingView.from(core.detail(meetingId));
    }
}
