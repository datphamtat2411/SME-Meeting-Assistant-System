package com.sme.meetingassistant.api.transcript.service;

import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository;
import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository.TranscriptSource;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Internal source contract for later Summary, Decisions and RAG writers.
 * A generation captures a source, and its DB persistence transaction must
 * recheck the identical source/version under a meeting lock.
 */
@Service
public class TranscriptSourceGuard {
    private final TranscriptRepository transcripts;

    public TranscriptSourceGuard(TranscriptRepository transcripts) {
        this.transcripts = transcripts;
    }

    @Transactional(readOnly = true)
    public TranscriptSource current(UUID meetingId) {
        if (meetingId == null) throw new IllegalArgumentException("Meeting id is required.");
        return this.transcripts.currentSource(meetingId)
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
    }

    /**
     * Validate manually selected evidence against the live current transcript.
     * Called after the Meeting row is locked by the Decision writer.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public TranscriptSource requireCurrentEvidence(UUID meetingId, List<UUID> segmentIds) {
        return transcripts.requireCurrentEvidence(meetingId, segmentIds);
    }

    /**
     * MI-06: fail closed if an AI proposal's pinned transcript has changed,
     * or referenced segments intersect suspicious/unresolved evidence.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void requireReviewableDecisionEvidence(UUID meetingId, UUID transcriptId,
            long contentRevision, List<UUID> segmentIds) {
        transcripts.requireReviewableDecisionEvidence(meetingId, transcriptId,
            contentRevision, segmentIds);
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void requireCurrentForDerivedWrite(UUID meetingId, TranscriptSource expected) {
        this.transcripts.requireCurrentSource(meetingId, expected);
    }
}
