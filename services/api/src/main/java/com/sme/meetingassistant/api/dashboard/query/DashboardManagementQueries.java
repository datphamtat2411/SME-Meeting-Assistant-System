package com.sme.meetingassistant.api.dashboard.query;

import com.sme.meetingassistant.api.actionitems.application.ManagedActionItemReportingPort;
import com.sme.meetingassistant.api.userorganization.service.OrganizationalAuthorizationService;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * DE-04 authorization-aware management read boundary. This transaction includes
 * current manager identity, granted ACTIVE units and official Action Item SQL.
 * Directory scope / Action Item scope does not grant Meeting-content access.
 */
@Service
public class DashboardManagementQueries {
    private final OrganizationalAuthorizationService authorization;
    private final ManagedActionItemReportingPort actions;

    public DashboardManagementQueries(OrganizationalAuthorizationService authorization,
            ManagedActionItemReportingPort actions) {
        this.authorization = authorization;
        this.actions = actions;
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public ManagementProjection currentManagedActionCohort(Instant asOf,
            Instant fromInclusive, Instant toExclusive, UUID requestedUnitId) {
        Objects.requireNonNull(asOf, "asOf");
        Objects.requireNonNull(fromInclusive, "fromInclusive");
        Objects.requireNonNull(toExclusive, "toExclusive");

        var scope = authorization.requireDirectoryManagementScope();
        // Global directory administrator privilege does not automatically grant
        // access to other users' work. Require exact current manager grants.
        if (scope.allUnits() || scope.unitIds().isEmpty()
                || (requestedUnitId != null && !scope.includes(requestedUnitId))) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        }
        UUID managerId = authorization.requireActiveActor().getId();
        var unitIds = requestedUnitId == null
                ? scope.unitIds().stream().sorted().toList()
                : List.of(requestedUnitId);
        var counts = actions.countOfficialCreatedIn(managerId, requestedUnitId,
                fromInclusive, toExclusive, asOf);
        return new ManagementProjection(asOf, fromInclusive, toExclusive, unitIds, counts);
    }

    /** Current-state cohort, not an as-of historical replay. */
    public record ManagementProjection(Instant asOf, Instant fromInclusive,
            Instant toExclusive, List<UUID> unitIds,
            ManagedActionItemReportingPort.OfficialCohort actions) {
        public ManagementProjection {
            unitIds = List.copyOf(unitIds);
        }
    }
}
