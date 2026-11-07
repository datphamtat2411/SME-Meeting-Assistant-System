package com.sme.meetingassistant.api.dashboard.dto;

import com.sme.meetingassistant.api.actionitems.application.ActionItemReportingPort;
import com.sme.meetingassistant.api.dashboard.query.DashboardReportingQueries;
import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import com.sme.meetingassistant.api.meeting.service.MeetingReportingPort;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * DE-03 public, explicit personal-dashboard representation. No persistence
 * entities, meeting transcript or processing job internals are exposed.
 */
public record PersonalDashboardView(
        OffsetDateTime asOf,
        String timezone,
        Window upcomingWindow,
        Window recentWindow,
        Map<MeetingStatus, Long> meetingCountsByState,
        List<MeetingCard> upcomingMeetings,
        List<MeetingCard> recentMeetings,
        AssignedActions assignedActionItems) {

    public PersonalDashboardView {
        meetingCountsByState = Map.copyOf(meetingCountsByState);
        upcomingMeetings = List.copyOf(upcomingMeetings);
        recentMeetings = List.copyOf(recentMeetings);
    }

    public static PersonalDashboardView from(DashboardReportingQueries.PersonalProjection source,
            String businessTimezone, DashboardReportingQueries.Window upcoming,
            DashboardReportingQueries.Window recent) {
        var counts = source.assignedOfficialActions();
        return new PersonalDashboardView(
                utc(source.asOf()), businessTimezone,
                Window.from(upcoming), Window.from(recent),
                source.visibleMeetingStates(),
                source.scheduledWindow().stream().map(MeetingCard::from).toList(),
                source.endedWindow().stream().map(MeetingCard::from).toList(),
                AssignedActions.from(counts));
    }

    private static OffsetDateTime utc(Instant instant) {
        return instant.atOffset(ZoneOffset.UTC);
    }

    /** All time windows are [fromInclusive, toExclusive) in absolute instants. */
    public record Window(OffsetDateTime fromInclusive, OffsetDateTime toExclusive, int limit) {
        static Window from(DashboardReportingQueries.Window source) {
            return new Window(utc(source.fromInclusive()), utc(source.toExclusive()), source.limit());
        }
    }

    public record MeetingCard(UUID id, String title, MeetingStatus status,
            OffsetDateTime scheduledStartAt, OffsetDateTime scheduledEndAt,
            OffsetDateTime endedAt) {
        static MeetingCard from(MeetingReportingPort.MeetingRow source) {
            return new MeetingCard(source.id(), source.title(), source.status(),
                    source.scheduledStartAt(), source.scheduledEndAt(), source.endedAt());
        }
    }

    /** Current official assigned work only; overdue is a subset, not a status. */
    public record AssignedActions(long open, long inProgress, long done, long overdue) {
        static AssignedActions from(ActionItemReportingPort.OfficialCounts source) {
            return new AssignedActions(source.open(), source.inProgress(),
                    source.done(), source.overdue());
        }
    }
}
