package com.sme.meetingassistant.api.meeting.dto;

import java.util.UUID;

/** An organizer label derived only from meetings visible to the current actor. */
public record MeetingOrganizerView(UUID id, String name) { }
