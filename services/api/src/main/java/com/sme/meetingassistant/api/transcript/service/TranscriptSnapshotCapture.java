package com.sme.meetingassistant.api.transcript.service;

import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;

/**
 * Transcript-owned consistent projection. Meeting lock serializes review and
 * publication while source text, coverage and speaker mapping are serialized.
 * Storage I/O is deliberately outside this transaction.
 */
@Service
public class TranscriptSnapshotCapture {
    private final TranscriptRepository transcripts;
    private final ObjectMapper json;

    public TranscriptSnapshotCapture(TranscriptRepository transcripts, ObjectMapper json) {
        this.transcripts = transcripts;
        this.json = json;
    }

    @Transactional
    public Captured capture(UUID meetingId) {
        transcripts.lockMeetingForReview(meetingId);
        var current = transcripts.current(meetingId).orElseThrow(() ->
            new ResponseStatusException(HttpStatus.CONFLICT, "A finalized transcript is required."));
        if (current.finalizedAt() == null
                || !("READY".equals(current.status()) || "READY_WITH_WARNINGS".equals(current.status()))
                || current.segments().isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "No eligible finalized transcript.");
        }
        // The immutable worker schema is independent of public HTTP DTO evolution.
        byte[] bytes = json.writeValueAsBytes(TranscriptSnapshotV1.from(
            current, transcripts.coverage(meetingId), transcripts.speakers(meetingId)));
        if (bytes.length == 0 || bytes.length > 8 * 1024 * 1024) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                "Transcript snapshot exceeds the approved size bound.");
        }
        return new Captured(current.id(), current.sourceMediaId(), current.processingJobId(),
            current.contentRevision(), current.status(), TranscriptCorrectionDigest.sha256(current.segments().stream()
                .map(s -> new TranscriptCorrectionDigest.SegmentDigest(s.ordinal(), s.startMs(), s.endMs(), s.text())).toList()),
            bytes);
    }

    public record Captured(UUID transcriptId, UUID mediaId, UUID originJobId,
            long contentRevision, String status, String correctionDigest, byte[] bytes) {
        public Captured { bytes = bytes.clone(); }
        @Override public byte[] bytes() { return bytes.clone(); }
    }
}
