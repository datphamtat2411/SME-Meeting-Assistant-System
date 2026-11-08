package com.sme.meetingassistant.api.dashboard.dto;

import com.sme.meetingassistant.api.actionitems.application.ManagedActionItemReportingPort;
import com.sme.meetingassistant.api.dashboard.query.DashboardManagementQueries;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;

/**
 * Explicit narrow management read DTO. Unapproved KPI populations are reported
 * unavailable instead of fabricated zero or unscoped private counts.
 */
public record ManagementDashboardView(
        OffsetDateTime asOf,
        String timezone,
        Period period,
        Scope scope,
        OfficialActions actionItems,
        List<DeferredMetric> unavailableMetrics) {

    private static final List<DeferredMetric> DEFERRED = List.of(
            new DeferredMetric("MEETING_COUNTS",
                    "MEETING_ORGANIZATIONAL_REPORTING_SCOPE_NOT_APPROVED"),
            new DeferredMetric("PROCESSING_OUTCOMES",
                    "AI_PROCESSING_REPORTING_SCOPE_AND_TAXONOMY_NOT_APPROVED"),
            new DeferredMetric("COMPLETION_RATE",
                    "PRODUCT_DENOMINATOR_AND_COHORT_POLICY_NOT_APPROVED"));

    public ManagementDashboardView {
        unavailableMetrics = List.copyOf(unavailableMetrics);
    }

    public static ManagementDashboardView from(
            DashboardManagementQueries.ManagementProjection projection, String timezone) {
        return new ManagementDashboardView(
                utc(projection.asOf()), timezone,
                new Period(utc(projection.fromInclusive()),
                        utc(projection.toExclusive()), "ACTION_ITEM_CREATED_AT",
                        "CURRENT_STATE"),
                new Scope("MANAGED_OFFICIAL_ACTION_ITEMS", projection.unitIds()),
                OfficialActions.from(projection.actions()),
                DEFERRED);
    }

    private static OffsetDateTime utc(java.time.Instant value) {
        return value.atOffset(ZoneOffset.UTC);
    }

    public record Period(OffsetDateTime fromInclusive, OffsetDateTime toExclusive,
            String cohortTimeField, String statusTimeSemantics) { }

    /** Org-unit IDs are active, currently granted units, not Meeting-content grants. */
    public record Scope(String type, List<UUID> organizationalUnitIds) {
        public Scope {
            organizationalUnitIds = List.copyOf(organizationalUnitIds);
        }
    }

    /**
     * totalOfficial includes CANCELLED for cohort accounting, but is NOT a
     * Product-approved completion-rate denominator.
     */
    public record OfficialActions(long open, long inProgress, long done,
            long cancelled, long overdue, long totalOfficial) {
        static OfficialActions from(ManagedActionItemReportingPort.OfficialCohort counts) {
            return new OfficialActions(counts.open(), counts.inProgress(), counts.done(),
                    counts.cancelled(), counts.overdue(), counts.totalOfficial());
        }
    }

    public record DeferredMetric(String metric, String reason) { }
}
