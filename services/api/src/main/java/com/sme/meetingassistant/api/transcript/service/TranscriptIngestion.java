package com.sme.meetingassistant.api.transcript.service;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Internal application boundary for validated, context-corrected AI transcript results. */
public interface TranscriptIngestion {
    void publish(TranscriptResult result);

    enum Status { READY, READY_WITH_WARNINGS }

    record TranscriptResult(UUID meetingId, UUID sourceMediaId, UUID processingJobId,
            UUID sourceStageRunId, String languageCode, Long durationMs, Status status,
            List<SegmentResult> segments, List<CoverageResult> coverage, List<SpeakerResult> speakers) {}

    /** text must be the validated LLM-corrected text, never raw ASR output. */
    record SegmentResult(int ordinal, long startMs, long endMs, String text, String qualityStatus,
            String speakerLabel, UUID sourceStageRunId, Map<String, Object> confidenceMetadata) {}

    record CoverageResult(long startMs, long endMs, String coverageStatus, boolean recovered,
            int retryCount, Map<String, Object> metadata) {}

    record SpeakerResult(String label) {}
}
