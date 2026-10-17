package com.sme.meetingassistant.api.meeting.service;

import java.util.UUID;

public interface MeetingAccess {

	void requireAccessible(UUID meetingId, UUID callerId);

}
