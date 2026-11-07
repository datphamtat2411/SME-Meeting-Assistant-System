package com.sme.meetingassistant.api.meetingminutes;

import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Immutable canonical Minutes representation. This is a read projection; it
 * never owns or mutates Meeting, Transcript, Summary, Decision or Action Item
 * state. The source fingerprint deliberately excludes volatile assembledAt.
 */
public record MinutesSnapshot(
        int schemaVersion,
        OffsetDateTime assembledAt,
        String sourceFingerprint,
        String completeness,
        Meeting meeting,
        Summary summary,
        List<Decision> confirmedDecisions,
        List<Action> officialActionItems,
        Transcript transcript,
        List<String> warnings,
        boolean proposalsIncluded) {

    public MinutesSnapshot {
        confirmedDecisions = List.copyOf(confirmedDecisions);
        officialActionItems = List.copyOf(officialActionItems);
        warnings = List.copyOf(warnings);
    }

    public record Meeting(UUID id, String title, String description, UUID organizerUserId,
            MeetingStatus status, OffsetDateTime scheduledStartAt, OffsetDateTime scheduledEndAt,
            OffsetDateTime startedAt, OffsetDateTime endedAt) { }

    /**
     * NOT_AVAILABLE is not an empty approved summary; NEEDS_REVIEW retains
     * content but explicitly signals stale or warned source attribution.
     */
    public record Summary(String availability, UUID id, Integer versionNumber,
            String content, String sourceType, String qualityStatus,
            UUID transcriptId, Long contentRevision, boolean isStale,
            List<String> aiWarnings) {
        public Summary {
            aiWarnings = List.copyOf(aiWarnings);
        }
    }

    /** Only decisions with canonical status CONFIRMED. */
    public record Decision(UUID id, String content, String status, String sourceType,
            UUID transcriptId, Long contentRevision, boolean isStale, long version,
            UUID confirmedByUserId, OffsetDateTime confirmedAt,
            List<UUID> evidenceSegmentIds, String aiUncertainty,
            List<String> aiWarnings) {
        public Decision {
            evidenceSegmentIds = List.copyOf(evidenceSegmentIds);
            aiWarnings = List.copyOf(aiWarnings);
        }
    }

    /** Only official, human-confirmed or manually created Action Items. */
    public record Action(UUID id, String title, String details, String status, String sourceType,
            UUID assigneeUserId, LocalDate dueDate, long version, OffsetDateTime createdAt,
            UUID confirmedByUserId, OffsetDateTime confirmedAt) { }

    /**
     * Current transcript identity and quality reference only; not a wholesale
     * transcript text export. No transcript is represented as NOT_AVAILABLE.
     */
    public record Transcript(String availability, UUID id, UUID processingJobId,
            Integer versionNumber, String languageCode, String status,
            Long contentRevision, Long durationMs, long suspiciousSegments,
            long unresolvedSegments, long unresolvedCoverageRegions) { }

    /** Stable fingerprint input; no assembledAt and no fingerprint self-reference. */
    public record CanonicalContent(int schemaVersion, String completeness,
            Meeting meeting, Summary summary, List<Decision> confirmedDecisions,
            List<Action> officialActionItems, Transcript transcript,
            List<String> warnings, boolean proposalsIncluded) {
        public CanonicalContent {
            confirmedDecisions = List.copyOf(confirmedDecisions);
            officialActionItems = List.copyOf(officialActionItems);
            warnings = List.copyOf(warnings);
        }
    }
}
