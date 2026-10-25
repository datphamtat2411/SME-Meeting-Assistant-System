package com.sme.meetingassistant.api.intelligence.dto;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

public record DecisionProposalInput(String statement, List<UUID> evidenceSegmentIds, BigDecimal confidence) {
}
