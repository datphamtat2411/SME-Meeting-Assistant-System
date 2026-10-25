package com.sme.meetingassistant.api.actionitem.dto;

import java.util.List;
import java.util.UUID;

public record IngestActionItemsRequest(UUID meetingId, UUID sourceTranscriptId, List<ActionItemProposalInput> items) {
}
