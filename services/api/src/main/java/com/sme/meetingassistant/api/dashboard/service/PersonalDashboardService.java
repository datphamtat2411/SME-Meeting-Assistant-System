package com.sme.meetingassistant.api.dashboard.service;

import com.sme.meetingassistant.api.dashboard.dto.PersonalDashboardView;
import com.sme.meetingassistant.api.dashboard.query.DashboardReportingQueries;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.Objects;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

/**
 * Application orchestration: capture one server time, build bounded absolute
 * windows and reuse DE-02's authorized, transactionally consistent projections.
 * The default horizons are explicitly provisional until DE-01 D07 sign-off.
 */
@Service
public class PersonalDashboardService {
    private final DashboardReportingQueries queries;
    private final Clock clock;
    private final ZoneId businessZone;

    public PersonalDashboardService(DashboardReportingQueries queries, Clock clock,
            @Value("${app.action-items.business-zone:UTC}") String businessZoneId) {
        this.queries = queries;
        this.clock = clock;
        this.businessZone = ZoneId.of(businessZoneId);
    }

    public PersonalDashboardView get(UUID currentActorId, int upcomingDays,
            int recentDays, int limit) {
        Objects.requireNonNull(currentActorId, "currentActorId");
        if (upcomingDays < 1 || upcomingDays > 90
                || recentDays < 1 || recentDays > 90
                || limit < 1 || limit > 50) {
            throw new IllegalArgumentException("Invalid personal dashboard window");
        }

        Instant asOf = clock.instant();
        var upcoming = new DashboardReportingQueries.Window(
                asOf, asOf.plus(Duration.ofDays(upcomingDays)), limit);
        var recent = new DashboardReportingQueries.Window(
                asOf.minus(Duration.ofDays(recentDays)), asOf, limit);
        var snapshot = queries.personal(currentActorId, asOf, upcoming, recent);
        return PersonalDashboardView.from(snapshot, businessZone.getId(), upcoming, recent);
    }
}
