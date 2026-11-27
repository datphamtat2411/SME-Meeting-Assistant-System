package com.sme.meetingassistant.api.transcript.service;

import com.sme.meetingassistant.api.transcript.dto.TranscriptViews.CoverageView;
import com.sme.meetingassistant.api.transcript.dto.TranscriptViews.SegmentView;
import com.sme.meetingassistant.api.transcript.dto.TranscriptViews.SpeakerView;
import com.sme.meetingassistant.api.transcript.dto.TranscriptViews.TranscriptView;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

/**
 * Immutable internal Meeting Intelligence source wire schema 1.0.
 * Keep this explicit projection separate from evolving public HTTP DTOs.
 * Public concurrency tokens are not evidence and are not part of schema 1.0.
 * Any change to this shape requires a coordinated worker contract change.
 */
record TranscriptSnapshotV1(String schemaVersion, Transcript transcript,
        List<Coverage> coverage, List<Speaker> speakers) {

    static TranscriptSnapshotV1 from(TranscriptView source, List<CoverageView> coverage,
            List<SpeakerView> speakers) {
        return new TranscriptSnapshotV1("1.0", Transcript.from(source),
            coverage.stream().map(Coverage::from).toList(),
            speakers.stream().map(Speaker::from).toList());
    }

    record Transcript(UUID id, UUID meetingId, UUID sourceMediaId, UUID processingJobId,
            int versionNumber, String languageCode, String status, Long durationMs,
            OffsetDateTime finalizedAt, long contentRevision, List<Segment> segments) {
        static Transcript from(TranscriptView source) {
            return new Transcript(source.id(), source.meetingId(), source.sourceMediaId(),
                source.processingJobId(), source.versionNumber(), source.languageCode(),
                source.status(), source.durationMs(), source.finalizedAt(), source.contentRevision(),
                source.segments().stream().map(Segment::from).toList());
        }
    }

    record Segment(UUID id, int ordinal, long startMs, long endMs, String text,
            String qualityStatus, UUID speakerClusterId, String speakerLabel, long version) {
        static Segment from(SegmentView source) {
            return new Segment(source.id(), source.ordinal(), source.startMs(), source.endMs(),
                source.text(), source.qualityStatus(), source.speakerClusterId(),
                source.speakerLabel(), source.version());
        }
    }

    record Coverage(UUID id, long startMs, long endMs, String coverageStatus,
            boolean recovered, int retryCount) {
        static Coverage from(CoverageView source) {
            return new Coverage(source.id(), source.startMs(), source.endMs(),
                source.coverageStatus(), source.recovered(), source.retryCount());
        }
    }

    record Speaker(UUID id, String label, UUID userId, String displayName) {
        static Speaker from(SpeakerView source) {
            return new Speaker(source.id(), source.label(), source.userId(), source.displayName());
        }
    }
}
