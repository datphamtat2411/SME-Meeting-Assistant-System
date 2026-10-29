package com.sme.meetingassistant.api.meeting.dto;

import com.sme.meetingassistant.api.room.availability.RoomAvailabilityService;
import java.util.List;
import java.util.UUID;

/** Warning details are deliberately limited to caller-accessible calendar data. */
public record MeetingScheduleCheckView(
    boolean previewOnly, boolean canSchedule, boolean roomConflict,
    RoomAvailabilityService.RoomSignal room, List<Warning> warnings
) {
    public record Warning(String code, UUID userId) { }
}
