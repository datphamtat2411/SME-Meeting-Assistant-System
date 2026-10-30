package com.sme.meetingassistant.api.transcript.dto;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

public final class TranscriptViews {
    private TranscriptViews() {}
    public record TranscriptView(UUID id, UUID meetingId, UUID sourceMediaId, UUID processingJobId,
            int versionNumber, String languageCode, String status, Long durationMs,
            OffsetDateTime finalizedAt, List<SegmentView> segments) {}
    public record SegmentView(UUID id, int ordinal, long startMs, long endMs, String text,
            String qualityStatus, UUID speakerClusterId, String speakerLabel, long version) {}
    public record CoverageView(UUID id, long startMs, long endMs, String coverageStatus,
            boolean recovered, int retryCount) {}
    public record SpeakerView(UUID id, String label, UUID userId, String displayName) {}
    public record CorrectionView(UUID id, String text, String qualityStatus, long version,
            UUID correctedByUserId, OffsetDateTime correctedAt) {}
    public record SpeakerMappingView(UUID speakerClusterId, UUID userId, String displayName) {}
}
