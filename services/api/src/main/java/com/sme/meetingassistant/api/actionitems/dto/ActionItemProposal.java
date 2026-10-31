package com.sme.meetingassistant.api.actionitems.dto;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/** Trusted internal proposal contract; AI output remains non-authoritative until human confirmation. */
public record ActionItemProposal(UUID meetingId, UUID processingJobId, String sourceItemKey,
        String title, String details, UUID suggestedAssigneeUserId, LocalDate dueDate,
        List<UUID> transcriptSegmentIds) { }
