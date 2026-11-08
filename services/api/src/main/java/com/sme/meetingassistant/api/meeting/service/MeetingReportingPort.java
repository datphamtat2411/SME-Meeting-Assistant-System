package com.sme.meetingassistant.api.meeting.service;

import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Meeting-owned reporting read boundary for authorized operational projections.
 * Does not authorize manager/administrator access to protected meeting content.
 */
public interface MeetingReportingPort {
    /** Counts distinct currently visible meetings by their execution state (not AI state). */
    Map<MeetingStatus, Long> countVisibleByStatus(UUID currentActorId);

    /** Scheduled meetings whose start instant belongs to [fromInclusive,toExclusive). */
    List<MeetingRow> scheduledStartingIn(UUID currentActorId, Instant fromInclusive,
            Instant toExclusive, int limit);

    /** Ended meetings whose actual end instant belongs to [fromInclusive,toExclusive). */
    List<MeetingRow> endedIn(UUID currentActorId, Instant fromInclusive,
            Instant toExclusive, int limit);

    record MeetingRow(UUID id, String title, MeetingStatus status,
            OffsetDateTime scheduledStartAt, OffsetDateTime scheduledEndAt,
            OffsetDateTime endedAt) { }
}
