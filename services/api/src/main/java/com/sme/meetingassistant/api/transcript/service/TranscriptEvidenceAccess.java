package com.sme.meetingassistant.api.transcript.service;

import java.util.List;
import java.util.UUID;

/** Read-only application boundary for validating references to transcript evidence. */
public interface TranscriptEvidenceAccess {

	void requireEvidenceBelongsToTranscript(UUID meetingId, UUID transcriptId, List<UUID> segmentIds);

}
