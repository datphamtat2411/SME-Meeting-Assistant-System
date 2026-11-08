package com.sme.meetingassistant.api.actionitems.application;

import com.sme.meetingassistant.api.actionitems.ActionItemView;
import java.util.List;
import java.util.UUID;

/** Action Items-owned read port; only actual official records, never AI proposals. */
public interface ActionItemMinutesSource {
    List<ActionItemView> officialForMeeting(UUID meetingId);
}
