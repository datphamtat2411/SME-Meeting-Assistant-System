package com.sme.meetingassistant.api.actionitems.application;

import java.time.Instant;
import java.util.UUID;

/**
 * Action Items-owned reporting of official work inside an explicit, currently
 * granted manager scope. This is NOT general meeting content authorization.
 */
public interface ManagedActionItemReportingPort {

    /**
     * The Action Item creation instant selects the cohort; statuses and overdue
     * reflect current canonical state. Both interval bounds are absolute,
     * [fromInclusive, toExclusive). A null unit means all currently granted units.
     * Caller must be an active, currently scoped Department Manager.
     */
    OfficialCohort countOfficialCreatedIn(UUID managerId, UUID unitId,
            Instant fromInclusive, Instant toExclusive, Instant asOf);

    record OfficialCohort(long open, long inProgress, long done,
            long cancelled, long overdue, long totalOfficial) {
        public OfficialCohort {
            if (open < 0 || inProgress < 0 || done < 0
                    || cancelled < 0 || overdue < 0 || totalOfficial < 0
                    || open + inProgress + done + cancelled != totalOfficial
                    || overdue > open + inProgress) {
                throw new IllegalArgumentException("Inconsistent managed Action Item cohort");
            }
        }
    }
}
