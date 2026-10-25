package com.sme.meetingassistant.api.actionitem.dto;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

public record ActionItemProposalInput(String title, UUID suggestedAssigneeId, LocalDate dueDate,
		List<UUID> evidenceSegmentIds) {
}
