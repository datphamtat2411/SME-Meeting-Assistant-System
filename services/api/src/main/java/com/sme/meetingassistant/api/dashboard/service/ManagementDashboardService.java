package com.sme.meetingassistant.api.dashboard.service;

import com.sme.meetingassistant.api.dashboard.dto.ManagementDashboardView;
import com.sme.meetingassistant.api.dashboard.query.DashboardManagementQueries;
import java.time.Clock;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.Objects;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Validate an explicit bounded reporting period. There is no implicit
 * unbounded all-time management report.
 */
@Service
public class ManagementDashboardService {
    private static final Duration MAX_PERIOD = Duration.ofDays(366);

    private final DashboardManagementQueries queries;
    private final Clock clock;
    private final ZoneId businessZone;

    public ManagementDashboardService(DashboardManagementQueries queries, Clock clock,
            @Value("${app.action-items.business-zone:UTC}") String businessZoneId) {
        this.queries = queries;
        this.clock = clock;
        this.businessZone = ZoneId.of(businessZoneId);
    }

    public ManagementDashboardView get(OffsetDateTime from, OffsetDateTime to, UUID orgUnitId) {
        Objects.requireNonNull(from, "from");
        Objects.requireNonNull(to, "to");
        var start = from.toInstant();
        var end = to.toInstant();
        if (!start.isBefore(end) || Duration.between(start, end).compareTo(MAX_PERIOD) > 0) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
        }
        var snapshot = queries.currentManagedActionCohort(clock.instant(), start, end, orgUnitId);
        return ManagementDashboardView.from(snapshot, businessZone.getId());
    }
}
