package com.sme.meetingassistant.api.actionitems;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

public record ActionItemView(UUID id, UUID meetingId, String title, String details,
        ActionItemStatus status, UUID assigneeUserId, LocalDate dueDate, boolean overdue,
        String sourceType, UUID processingJobId, UUID createdByUserId,
        UUID confirmedByUserId, OffsetDateTime confirmedAt, UUID completedByUserId,
        OffsetDateTime completedAt, UUID cancelledByUserId, OffsetDateTime cancelledAt,
        long version, OffsetDateTime createdAt, OffsetDateTime updatedAt) {
    public static boolean overdue(LocalDate dueDate, ActionItemStatus status) {
        return dueDate != null && dueDate.isBefore(OffsetDateTime.now(ZoneOffset.UTC).toLocalDate())
            && status != ActionItemStatus.DONE && status != ActionItemStatus.CANCELLED;
    }
}
