package com.sme.meetingassistant.api.meetingintelligence.service;

import com.sme.meetingassistant.api.audit.TransactionalAuditWriter;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;

/** MI-11 allowlisted business audit: never store content, payload or secrets. */
@Service
public class MeetingIntelligenceAudit {
    private final TransactionalAuditWriter writer;
    public MeetingIntelligenceAudit(TransactionalAuditWriter writer) { this.writer = writer; }

    public void summaryEdited(UUID actor, UUID meetingId, UUID previousId,
            UUID newId, int fromVersion, int toVersion, boolean stale) {
        writer.record(actor, "MI_SUMMARY_EDITED", "MEETING_SUMMARY", newId, meetingId,
            Map.of("schemaVersion", 1, "previousVersionId", previousId,
                "previousVersion", fromVersion, "newVersion", toVersion, "sourceStale", stale));
    }

    public void summaryActivated(UUID actor, UUID meetingId, UUID previousId,
            UUID selectedId, int selectedVersion, long contentRevision) {
        writer.record(actor,"MI_SUMMARY_VERSION_ACTIVATED","MEETING_SUMMARY",
            selectedId,meetingId,Map.of("schemaVersion",1,
                "previousVersionId",previousId,"selectedVersion",selectedVersion,
                "contentRevision",contentRevision));
    }

    public void decisionCreated(UUID actor, UUID meetingId, UUID decisionId, int evidenceCount) {
        writer.record(actor, "MI_DECISION_CREATED", "MEETING_DECISION", decisionId, meetingId,
            Map.of("schemaVersion", 1, "status", "CONFIRMED",
                "sourceType", "MANUAL", "evidenceCount", evidenceCount));
    }

    public void decisionEdited(UUID actor, UUID meetingId, UUID decisionId,
            long fromVersion, long toVersion) {
        writer.record(actor, "MI_DECISION_EDITED", "MEETING_DECISION", decisionId, meetingId,
            Map.of("schemaVersion", 1, "previousVersion", fromVersion, "newVersion", toVersion));
    }

    public void decisionReviewed(UUID actor, UUID meetingId, UUID decisionId,
            boolean confirmed, long fromVersion, long toVersion) {
        writer.record(actor, confirmed ? "MI_DECISION_CONFIRMED" : "MI_DECISION_REJECTED",
            "MEETING_DECISION", decisionId, meetingId,
            Map.of("schemaVersion", 1, "fromStatus", "PROPOSED",
                "toStatus", confirmed ? "CONFIRMED" : "REJECTED",
                "previousVersion", fromVersion, "newVersion", toVersion));
    }

    public void regenerationRequested(UUID actor, UUID meetingId, UUID jobId,
            UUID transcriptId, long contentRevision) {
        writer.record(actor, "MI_SUMMARY_REGENERATION_REQUESTED", "PROCESSING_JOB", jobId, meetingId,
            Map.of("schemaVersion", 1, "transcriptId", transcriptId,
                "contentRevision", contentRevision, "operation", "GENERATING_SUMMARY"));
    }

    public void resultAccepted(UUID meetingId, UUID receiptId, UUID jobId, UUID stageRunId,
            UUID transcriptId, long revision, String resultType, int newRows) {
        writer.recordService("MI_AI_RESULT_ACCEPTED", "INTELLIGENCE_RESULT", receiptId, meetingId,
            Map.of("schemaVersion", 1, "processingJobId", jobId, "stageRunId", stageRunId,
                "transcriptId", transcriptId, "contentRevision", revision,
                "resultType", resultType, "newRows", newRows));
    }
}
