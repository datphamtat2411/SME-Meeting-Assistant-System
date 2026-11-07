package com.sme.meetingassistant.api.dashboard.query;

import com.sme.meetingassistant.api.actionitems.application.ActionItemReportingPort;
import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import com.sme.meetingassistant.api.meeting.service.MeetingReportingPort;
import com.sme.meetingassistant.api.media.service.ProcessingReportingPort;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

/**
 * DE-02 internal query foundation only; NOT a published Dashboard contract.
 *
 * A single REPEATABLE_READ transaction prevents a multi-query response from
 * combining different committed snapshots. Source feature ports own SQL and
 * independently fail closed against the current server-authenticated actor.
 * No Product-undefined completion rate, management attribution, or AI
 * "latest failed meeting" interpretation is implemented here.
 */
@Service
public class DashboardReportingQueries {
    private final MeetingReportingPort meeting;
    private final ActionItemReportingPort actions;
    private final ProcessingReportingPort processing;

    public DashboardReportingQueries(MeetingReportingPort meeting,
            ActionItemReportingPort actions, ProcessingReportingPort processing) {
        this.meeting = meeting;
        this.actions = actions;
        this.processing = processing;
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public AuthorizedProjection currentVisible(UUID currentActorId, Instant asOf,
            Window scheduledStarts, Window actualEnds) {
        Objects.requireNonNull(currentActorId, "currentActorId");
        Objects.requireNonNull(asOf, "asOf");
        Objects.requireNonNull(scheduledStarts, "scheduledStarts");
        Objects.requireNonNull(actualEnds, "actualEnds");
        return new AuthorizedProjection(asOf,
                meeting.countVisibleByStatus(currentActorId),
                meeting.scheduledStartingIn(currentActorId, scheduledStarts.fromInclusive(),
                        scheduledStarts.toExclusive(), scheduledStarts.limit()),
                meeting.endedIn(currentActorId, actualEnds.fromInclusive(),
                        actualEnds.toExclusive(), actualEnds.limit()),
                actions.assignedOfficial(currentActorId, asOf),
                actions.visibleOfficial(currentActorId, asOf),
                processing.visibleJobStatusCounts(currentActorId));
    }

    /** Explicit internal query bounds: no implicit product horizon is selected. */
    public record Window(Instant fromInclusive, Instant toExclusive, int limit) {
        public Window {
            Objects.requireNonNull(fromInclusive, "fromInclusive");
            Objects.requireNonNull(toExclusive, "toExclusive");
            if (!fromInclusive.isBefore(toExclusive) || limit < 1 || limit > 100) {
                throw new IllegalArgumentException("Invalid reporting window or limit");
            }
        }
    }

    /** Immutable transport-independent read projection. Not a public API DTO. */
    public record AuthorizedProjection(Instant asOf,
            Map<MeetingStatus, Long> visibleMeetingStates,
            List<MeetingReportingPort.MeetingRow> scheduledWindow,
            List<MeetingReportingPort.MeetingRow> endedWindow,
            ActionItemReportingPort.OfficialCounts assignedOfficialActions,
            ActionItemReportingPort.OfficialCounts visibleOfficialActions,
            Map<String, Long> visibleTechnicalJobStates) {
        public AuthorizedProjection {
            visibleMeetingStates = Map.copyOf(visibleMeetingStates);
            scheduledWindow = List.copyOf(scheduledWindow);
            endedWindow = List.copyOf(endedWindow);
            visibleTechnicalJobStates = Map.copyOf(visibleTechnicalJobStates);
        }
    }
}
