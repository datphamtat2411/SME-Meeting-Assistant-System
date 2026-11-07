package com.sme.meetingassistant.api.meeting.service;

import java.util.UUID;
import java.util.List;

/** Meeting-owned boundary for action-item visibility, management, and assignment eligibility. */
public interface MeetingActionItemAccess {
    void requireCurrentActiveActor(UUID actorId);
    void requireActionItemReadable(UUID meetingId, UUID actorId);
    void requireOrganizer(UUID meetingId, UUID actorId);
    void requireManageActionItems(UUID meetingId, UUID actorId);
    boolean isOrganizer(UUID meetingId, UUID actorId);
    boolean canManageActionItems(UUID meetingId, UUID actorId);
    boolean isActiveAssignee(UUID userId);
    List<UUID> actionItemManagerMeetingIds(UUID actorId);
}
