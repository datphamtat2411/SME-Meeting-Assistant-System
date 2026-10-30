package com.sme.meetingassistant.api.meeting.service;

import java.util.UUID;

/**
 * Meeting-owned authorization boundary for media operations.
 * A global organizational role is not authority over meeting content.
 */
public interface MeetingMediaAccess {
    /** Meeting metadata/media/job status for a current content reader. */
    void requireReadable(UUID meetingId, UUID actorId);

    /** Mint a source-audio download capability only for a current content reader. */
    void requireSourceReadable(UUID meetingId, UUID actorId);

    /** Starting or completing upload requires current organizer authority. */
    void requireUploadAllowed(UUID meetingId, UUID actorId);

    /** AI resource admission is distinct from reading meeting content. */
    void requireProcessingAllowed(UUID meetingId, UUID actorId);

    /** Transcript edits are reserved for the current meeting organizer. */
    void requireTranscriptEditAllowed(UUID meetingId, UUID actorId);

    /** A mapped speaker must be a current participant or the meeting organizer. */
    void requireTranscriptSpeakerMember(UUID meetingId, UUID userId);
}
