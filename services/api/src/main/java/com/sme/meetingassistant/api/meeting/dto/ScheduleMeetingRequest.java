package com.sme.meetingassistant.api.meeting.dto;

import java.time.OffsetDateTime;

/** Optional command interval; omitted interval uses the draft's planned schedule. */
public record ScheduleMeetingRequest(OffsetDateTime scheduledStartAt, OffsetDateTime scheduledEndAt) { }
