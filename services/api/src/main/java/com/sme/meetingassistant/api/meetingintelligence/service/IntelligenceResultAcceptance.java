package com.sme.meetingassistant.api.meetingintelligence.service;

import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.DerivedStage;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceResultArtifactReader.ResultArtifact;
import com.sme.meetingassistant.api.transcript.repository.TranscriptRepository.DerivedSource;
import com.sme.meetingassistant.api.transcript.service.TranscriptSourceGuard;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * In-process, API-owned acceptance transaction. No HTTP endpoint, no anonymous
 * worker route, and no untrusted message can directly write canonical state.
 * The caller must carry a Media-issued live StageClaim, and storage bytes must
 * already have been read and SHA-256 verified by the internal adapter.
 */
@Service
public class IntelligenceResultAcceptance {
    private final JdbcTemplate jdbc;
    private final ProcessingJobLifecycle media;
    private final TranscriptSourceGuard transcript;

    public IntelligenceResultAcceptance(JdbcTemplate jdbc, ProcessingJobLifecycle media,
            TranscriptSourceGuard transcript) {
        this.jdbc = jdbc;
        this.media = media;
        this.transcript = transcript;
    }

    public record Acceptance(boolean replay, int writtenRows) { }
    private record Snapshot(UUID id, UUID transcript, long revision, String sha) { }
    private record Receipt(String type, String digest, String key) { }

    @Transactional
    public Acceptance accept(StageClaim claim, DerivedStage stage,
            ResultArtifact artifact, IntelligenceResultPayload payload) {
        if (claim == null || claim.claimToken() == null || claim.stageRunId() == null
                || stage == null || !claim.stageRunId().equals(payload.stageRunId())
                || !stage.jobId().equals(payload.jobId())) {
            throw new IllegalArgumentException("Worker result does not match a Media stage claim.");
        }
        String required = "SUMMARY".equals(payload.resultType())
            ? "GENERATING_SUMMARY" : "EXTRACTING_DECISIONS";
        if (!required.equals(stage.stageCode())) {
            throw new IllegalArgumentException("Result type does not match the producing stage.");
        }
        // All writers share the same meeting-first lock (Transcript, Summary,
        // Decisions). Media completion then locks job -> stage, in that order.
        List<UUID> locked = jdbc.query("SELECT id FROM meetings WHERE id=? FOR UPDATE",
            (rs,n)->rs.getObject(1,UUID.class), stage.meetingId());
        if (locked.size()!=1) throw new IllegalArgumentException("Derived job meeting is missing.");

        List<Receipt> receipts=jdbc.query("""
            SELECT result_type,artifact_sha256,artifact_object_key
            FROM meeting_intelligence_result_receipts WHERE stage_run_id=?
            """, (rs,n)->new Receipt(rs.getString("result_type"),
                rs.getString("artifact_sha256"),rs.getString("artifact_object_key")),
            payload.stageRunId());
        if (!receipts.isEmpty()) {
            Receipt prior=receipts.getFirst();
            if (prior.type().equals(payload.resultType())
                    && prior.digest().equals(artifact.sha256())
                    && prior.key().equals(artifact.objectKey())) {
                // Committed receipt is the acknowledgement; do not re-run the
                // completed stage or change human-confirmed downstream rows.
                return new Acceptance(true,0);
            }
            throw new IllegalArgumentException("Conflicting accepted AI result for stage attempt.");
        }

        List<Snapshot> snapshots=jdbc.query("""
            SELECT id,transcript_id,content_revision,sha256
            FROM meeting_intelligence_source_snapshots
            WHERE id=? AND meeting_id=? AND processing_job_id=? AND source_media_id=?
            """, (rs,n)->new Snapshot(rs.getObject("id",UUID.class),
                rs.getObject("transcript_id",UUID.class),
                rs.getLong("content_revision"),rs.getString("sha256")),
            payload.inputSnapshotId(),stage.meetingId(),stage.jobId(),stage.sourceMediaId());
        if (snapshots.size()!=1) throw new IllegalArgumentException("No verified source snapshot for this job.");
        Snapshot source=snapshots.getFirst();
        if (!source.transcript().equals(payload.transcriptId())
                || source.revision()!=payload.contentRevision()
                || !source.sha().equals(payload.sourceSha256())) {
            throw new IllegalArgumentException("AI output does not match its pinned transcript snapshot.");
        }
        DerivedSource evidence=transcript.derivedSource(stage.meetingId(),
            source.transcript(),source.revision());
        if (!evidence.eligible()) {
            throw new IllegalArgumentException("AI result source is not a finalized transcript.");
        }

        // Reject all invalid candidate evidence before the first domain write.
        if ("DECISION_EXTRACTION".equals(payload.resultType())) {
            for (var candidate : payload.candidates()) {
                transcript.requireDerivedSegments(stage.meetingId(),source.transcript(),
                    candidate.evidenceSegmentIds());
            }
        }

        UUID receiptId=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_intelligence_result_receipts(
                id,meeting_id,processing_job_id,stage_run_id,result_type,
                source_snapshot_id,transcript_id,content_revision,artifact_sha256,
                artifact_object_key,artifact_size_bytes)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """,receiptId,stage.meetingId(),stage.jobId(),payload.stageRunId(),
            payload.resultType(),source.id(),source.transcript(),source.revision(),
            artifact.sha256(),artifact.objectKey(),artifact.sizeBytes());

        int written;
        if ("SUMMARY".equals(payload.resultType())) {
            int version=jdbc.queryForObject("""
                SELECT COALESCE(MAX(version_number),0)+1
                FROM meeting_summary_versions WHERE meeting_id=?
                """,Integer.class,stage.meetingId());
            Boolean hasCurrent=jdbc.queryForObject("""
                SELECT EXISTS(SELECT 1 FROM meeting_summary_versions
                    WHERE meeting_id=? AND is_current)
                """,Boolean.class,stage.meetingId());
            // Never displace ANY current Summary, including one produced by AI.
            boolean promote=evidence.current() && !Boolean.TRUE.equals(hasCurrent);
            jdbc.update("""
                INSERT INTO meeting_summary_versions(
                    id,meeting_id,version_number,content,source_type,
                    processing_job_id,result_receipt_id,transcript_id,
                    content_revision,quality_status,is_current)
                VALUES (?,?,?,?,'AI_GENERATED',?,?,?, ?,?,?)
                """,UUID.randomUUID(),stage.meetingId(),version,payload.summary(),
                stage.jobId(),receiptId,source.transcript(),source.revision(),
                evidence.hasQualityWarnings()?"READY_WITH_WARNINGS":"READY",promote);
            written=1;
        } else {
            for (var candidate:payload.candidates()) {
                UUID id=UUID.randomUUID();
                jdbc.update("""
                    INSERT INTO meeting_decisions(
                        id,meeting_id,content,status,source_type,processing_job_id,
                        result_receipt_id,candidate_key,transcript_id,content_revision)
                    VALUES (?,?,?,'PROPOSED','AI_EXTRACTED',?,?,?,?,?)
                    """,id,stage.meetingId(),candidate.content(),stage.jobId(),
                    receiptId,candidate.key(),source.transcript(),source.revision());
                for (UUID segment:candidate.evidenceSegmentIds()) {
                    jdbc.update("""
                        INSERT INTO decision_evidence(
                            decision_id,transcript_id,transcript_segment_id)
                        VALUES (?,?,?)
                        """,id,source.transcript(),segment);
                }
            }
            written=payload.candidates().size();
        }

        // Critical: if the Media lease expired, was superseded, or the job
        // stopped running, this throws and rolls back receipt + every row.
        media.completeStage(claim,"SUCCEEDED",null,null);
        return new Acceptance(false,written);
    }
}
