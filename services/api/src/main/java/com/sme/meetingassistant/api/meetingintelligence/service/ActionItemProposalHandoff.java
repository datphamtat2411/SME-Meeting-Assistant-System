package com.sme.meetingassistant.api.meetingintelligence.service;

import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.transcript.service.TranscriptSourceGuard;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;

/**
 * MI-10: strictly internal handoff to the *Action Items-owned* canonical
 * proposal sink. Does not create Decisions, Action Items tables or HTTP routes.
 * No sink is installed until MI-01 G7; fail closed rather than reporting
 * accepted extraction or completing the Media stage.
 */
@Service
public class ActionItemProposalHandoff {
    private final JdbcTemplate jdbc;
    private final ProcessingJobLifecycle media;
    private final TranscriptSourceGuard transcripts;
    private final ObjectProvider<ActionItemProposalSink> sinks;
    private final ObjectMapper mapper;

    public ActionItemProposalHandoff(JdbcTemplate jdbc, ProcessingJobLifecycle media,
            TranscriptSourceGuard transcripts, ObjectProvider<ActionItemProposalSink> sinks,
            ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.media = media;
        this.transcripts = transcripts;
        this.sinks = sinks;
        this.mapper = mapper;
    }

    /**
     * The caller is an authenticated in-process worker adapter, not public
     * HTTP or model-supplied identity. A Media StageClaim and pinned source
     * snapshot are mandatory. The Action Items owner handles business
     * permissions and future confirm/reject of each PROPOSED item.
     */
    @Transactional
    public ActionItemProposalSink.Receipt handoff(StageClaim claim, SourceReference source,
            List<ActionItemProposalSink.Candidate> candidates) {
        if (claim == null || claim.stageRunId() == null || claim.claimToken() == null
                || source == null || source.snapshotId() == null
                || source.transcriptId() == null || source.contentRevision() < 0
                || source.sha256() == null || !source.sha256().matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("Trusted source and Media stage claim are required.");
        }
        validateCandidates(candidates);
        ActionItemProposalSink sink = sinks.getIfAvailable();
        if (sink == null) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Action Items proposal consumer is not installed.");
        }

        var stage = media.derivedStage(claim.stageRunId());
        if (!"EXTRACTING_ACTION_ITEMS".equals(stage.stageCode())) {
            throw new IllegalArgumentException("Not an Action Item extraction stage.");
        }

        // The same meeting-first lock as Summary/Decision/Transcript writers.
        var locked = jdbc.query("SELECT id FROM meetings WHERE id=? FOR UPDATE",
            (rs, n) -> rs.getObject("id", UUID.class), stage.meetingId());
        if (locked.size() != 1) {
            throw new IllegalArgumentException("Meeting for extraction is missing.");
        }
        media.requireActionItemExtractionClaim(stage.jobId(), stage.meetingId(),
            stage.sourceMediaId(), claim);

        // Source snapshot is canonical API-owned data; caller cannot invent
        // transcript, revision, media identity or checksum.
        Boolean pinned = jdbc.queryForObject("""
            SELECT EXISTS (
              SELECT 1 FROM meeting_intelligence_source_snapshots
              WHERE id=? AND meeting_id=? AND processing_job_id=?
                AND source_media_id=? AND transcript_id=?
                AND content_revision=? AND sha256=?
            )
            """, Boolean.class, source.snapshotId(), stage.meetingId(), stage.jobId(),
            stage.sourceMediaId(), source.transcriptId(), source.contentRevision(),
            source.sha256());
        if (!Boolean.TRUE.equals(pinned)) {
            throw new IllegalArgumentException("Action Item extraction source is not pinned to this job.");
        }

        var provenance = transcripts.derivedSource(stage.meetingId(),
            source.transcriptId(), source.contentRevision());
        if (!provenance.eligible()) {
            throw new IllegalArgumentException("Action Item extraction source was not finalized.");
        }
        for (var candidate : candidates) {
            transcripts.requireDerivedSegments(stage.meetingId(), source.transcriptId(),
                candidate.evidenceSegmentIds());
        }

        // Producer identity and deterministic fingerprint are metadata, never
        // authority to create OPEN obligations or to assign a user.
        var batch = new ActionItemProposalSink.Batch(stage.meetingId(), stage.jobId(),
            claim.stageRunId(), source.snapshotId(), source.transcriptId(),
            source.contentRevision(), !provenance.current(),
            fingerprint(candidates), candidates);
        var receipt = sink.acceptProposed(batch);
        if (receipt == null || receipt.newProposals() < 0
                || receipt.newProposals() > candidates.size()
                || (receipt.replay() && receipt.newProposals() != 0)) {
            throw new IllegalStateException("Action Items sink returned an invalid acceptance receipt.");
        }
        if (!receipt.replay()) {
            // Synchronous same-database transaction: failed stage completion
            // rolls back Action Items proposals and any acceptance receipt.
            media.completeStage(claim, "SUCCEEDED", null, null);
        }
        return receipt;
    }

    public record SourceReference(UUID snapshotId, UUID transcriptId,
            long contentRevision, String sha256) {}

    private static void validateCandidates(List<ActionItemProposalSink.Candidate> items) {
        if (items == null || items.size() > 200) {
            throw new IllegalArgumentException("Action Item candidate batch exceeds bounds.");
        }
        var keys = new HashSet<String>();
        for (var c : items) {
            if (c == null || c.candidateKey() == null
                    || !c.candidateKey().matches("[A-Za-z0-9._-]{1,128}")
                    || !keys.add(c.candidateKey()) || c.title() == null
                    || c.title().isBlank() || c.title().length() > 500
                    || c.details() != null && c.details().length() > 10_000
                    || c.evidenceSegmentIds().isEmpty()
                    || c.evidenceSegmentIds().size() > 50
                    || c.evidenceSegmentIds().stream().anyMatch(x -> x == null)
                    || new HashSet<>(c.evidenceSegmentIds()).size() != c.evidenceSegmentIds().size()) {
                throw new IllegalArgumentException("Invalid or duplicate Action Item extraction candidate.");
            }
        }
    }

    private String fingerprint(List<ActionItemProposalSink.Candidate> items) {
        byte[] encoded = mapper.writeValueAsBytes(items);
        try {
            return HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(encoded));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable.", impossible);
        }
    }
}
