package com.sme.meetingassistant.api.media.service;

import java.util.Map;
import java.util.UUID;

/**
 * Media-owned technical processing-job state aggregates, visible only to the
 * current Meeting content reader. Raw job counts are not meeting-level
 * "latest processing failed" or review KPIs (policy pending DE-01 D06).
 */
public interface ProcessingReportingPort {
    Map<String, Long> visibleJobStatusCounts(UUID currentActorId);
}
