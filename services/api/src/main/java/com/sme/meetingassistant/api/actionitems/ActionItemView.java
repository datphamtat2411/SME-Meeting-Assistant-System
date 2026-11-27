package com.sme.meetingassistant.api.actionitems;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;
import java.time.ZoneOffset;
import java.util.UUID;

public record ActionItemView(UUID id, UUID meetingId, String title, String details,
        ActionItemStatus status, UUID assigneeUserId, LocalDate dueDate, boolean overdue,
        String sourceType, UUID processingJobId, UUID transcriptId, Long contentRevision,
        UUID createdByUserId,
        UUID confirmedByUserId, OffsetDateTime confirmedAt, UUID completedByUserId,
        OffsetDateTime completedAt, UUID cancelledByUserId, OffsetDateTime cancelledAt,
        long version, OffsetDateTime createdAt, OffsetDateTime updatedAt,
        boolean isOfficial, Capabilities capabilities, Assignee assignee,
        MeetingDisplay meeting, Evidence evidence) {
    public ActionItemView(UUID id, UUID meetingId, String title, String details,
            ActionItemStatus status, UUID assigneeUserId, LocalDate dueDate, boolean overdue,
            String sourceType, UUID processingJobId, UUID createdByUserId,
            UUID confirmedByUserId, OffsetDateTime confirmedAt, UUID completedByUserId,
            OffsetDateTime completedAt, UUID cancelledByUserId, OffsetDateTime cancelledAt,
        long version, OffsetDateTime createdAt, OffsetDateTime updatedAt) {
        this(id, meetingId, title, details, status, assigneeUserId, dueDate, overdue,
                sourceType, processingJobId, null, null, createdByUserId,
                confirmedByUserId, confirmedAt,
                completedByUserId, completedAt, cancelledByUserId, cancelledAt, version,
                createdAt, updatedAt, isOfficial(sourceType, confirmedByUserId),
                Capabilities.none(), null, null, null);
    }

    public static boolean overdue(LocalDate dueDate, ActionItemStatus status) {
        return dueDate != null && dueDate.isBefore(OffsetDateTime.now(ZoneOffset.UTC).toLocalDate())
            && status != ActionItemStatus.DONE && status != ActionItemStatus.CANCELLED;
    }

    private static boolean isOfficial(String sourceType, UUID confirmedByUserId) {
        return "MANUAL".equals(sourceType) || confirmedByUserId != null;
    }

    public record Capabilities(boolean canEdit, boolean canAssign, boolean canConfirm,
            boolean canReject, boolean canStart, boolean canComplete, boolean canCancel,
            boolean canReopen, boolean canAccessMeeting, boolean canAccessEvidence) {
        public static Capabilities none() {
            return new Capabilities(false, false, false, false, false, false, false,
                    false, false, false);
        }
    }

    public record Assignee(UUID id, String displayName, boolean active) { }

    public record MeetingDisplay(UUID id, String label, boolean restricted) { }

    public record Evidence(String availability, UUID transcriptId, Long contentRevision,
            String freshness, List<Reference> references, String limitation) {
        public Evidence {
            references = references == null ? List.of() : List.copyOf(references);
        }
    }

    public record Reference(UUID segmentId, Integer ordinal, String preview) { }

    public ActionItemView withProjection(boolean official, Capabilities resourceCapabilities,
            Assignee resourceAssignee, MeetingDisplay originatingMeeting,
            Evidence sourceEvidence) {
        return new ActionItemView(id, meetingId, title, details, status, assigneeUserId,
                dueDate, overdue, sourceType, processingJobId, transcriptId, contentRevision,
                createdByUserId,
                confirmedByUserId, confirmedAt, completedByUserId, completedAt,
                cancelledByUserId, cancelledAt, version, createdAt, updatedAt, official,
                resourceCapabilities, resourceAssignee, originatingMeeting, sourceEvidence);
    }
}
