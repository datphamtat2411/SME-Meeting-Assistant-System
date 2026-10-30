package com.sme.meetingassistant.api.meeting.dto;

/**
 * Optional, mutually exclusive views over the caller's current meeting access.
 *
 * <p>Omitted filter: all accessible meetings. ORGANIZER: meetings organized
 * by the caller. PARTICIPANT: active meeting membership where the caller is
 * not the organizer (organizers also have a canonical participant row).
 * Historical/removed memberships never convey access.
 *
 * <p>This filter NEVER accepts another user's identifier as its subject.
 */
public enum MeetingRelationshipFilter {
    ORGANIZER,
    PARTICIPANT
}
