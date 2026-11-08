package com.sme.meetingassistant.api.actionitems.application;

import java.time.Instant;
import java.util.UUID;

/**
 * Action Items-owned current official-work aggregate boundary.
 * These counts are not a Product-approved completion-rate or management cohort.
 */
public interface ActionItemReportingPort {
    /** Count only official work currently assigned to this active actor. */
    OfficialCounts assignedOfficial(UUID currentActorId, Instant asOf);

    /**
     * Count official items visible under existing Action Items read permissions.
     * This is an authorized visibility population, NOT an approved management
     * organization attribution rule.
     */
    OfficialCounts visibleOfficial(UUID currentActorId, Instant asOf);

    record OfficialCounts(long open, long inProgress, long done,
            long cancelled, long overdue) {
        public OfficialCounts {
            if (open < 0 || inProgress < 0 || done < 0 || cancelled < 0 || overdue < 0) {
                throw new IllegalArgumentException("Negative action-item count");
            }
        }
    }
}
