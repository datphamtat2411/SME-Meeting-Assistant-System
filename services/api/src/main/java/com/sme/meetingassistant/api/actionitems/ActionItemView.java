package com.sme.meetingassistant.api.actionitems;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
import java.util.List;
import com.sme.meetingassistant.api.actionitems.ActionItemLifecycle.Command;

public record ActionItemView(UUID id, UUID meetingId, String title, String details,
        ActionItemStatus status, UUID assigneeUserId, LocalDate dueDate, boolean overdue,
        String sourceType, UUID processingJobId, UUID createdByUserId,
        UUID confirmedByUserId, OffsetDateTime confirmedAt, UUID completedByUserId,
        OffsetDateTime completedAt, UUID cancelledByUserId, OffsetDateTime cancelledAt,
        long version, OffsetDateTime createdAt, OffsetDateTime updatedAt,
        boolean official, Assignee assignee, MeetingContext meetingContext, Capabilities capabilities) {

    // Internal canonical row, before applying actor-specific visibility.
    public ActionItemView(UUID id, UUID meetingId, String title, String details,
            ActionItemStatus status, UUID assigneeUserId, LocalDate dueDate, boolean overdue,
            String sourceType, UUID processingJobId, UUID createdByUserId,
            UUID confirmedByUserId, OffsetDateTime confirmedAt, UUID completedByUserId,
            OffsetDateTime completedAt, UUID cancelledByUserId, OffsetDateTime cancelledAt,
            long version, OffsetDateTime createdAt, OffsetDateTime updatedAt) {
        this(id, meetingId, title, details, status, assigneeUserId, dueDate, overdue,
            sourceType, processingJobId, createdByUserId, confirmedByUserId, confirmedAt,
            completedByUserId, completedAt, cancelledByUserId, cancelledAt, version,
            createdAt, updatedAt, "MANUAL".equals(sourceType) || confirmedByUserId != null,
            null, null, null);
    }

    public record Assignee(UUID id, String displayName, String accountStatus) {}
    public record MeetingContext(UUID id, String title) {}
    public record Capabilities(boolean canEdit, boolean canAssign, boolean canReadMeetingContext,
            List<Command> allowedCommands) {}
    public record CreationMeeting(UUID id, String title, boolean canReadMeetingContext) {}

    public static boolean overdue(LocalDate dueDate, ActionItemStatus status) {
        return dueDate != null && dueDate.isBefore(OffsetDateTime.now(ZoneOffset.UTC).toLocalDate())
            && status != ActionItemStatus.DONE && status != ActionItemStatus.CANCELLED;
    }
}
