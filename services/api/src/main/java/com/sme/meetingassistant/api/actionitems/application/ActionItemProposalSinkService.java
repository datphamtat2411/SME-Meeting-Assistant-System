package com.sme.meetingassistant.api.actionitems.application;

import com.sme.meetingassistant.api.actionitem.service.ActionItemBatchFingerprint;
import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.ObjectMapper;

/**
 * Canonical Action Items-owned MI-10 sink.
 *
 * This is an in-process transactional port, NOT an HTTP/worker endpoint.
 * The handoff holds the Meeting -> Media claim locks and verifies snapshot,
 * transcript revision and evidence eligibility before invoking this service.
 * PostgreSQL foreign keys independently enforce receipt/segment lineage.
 */
@Service
public final class ActionItemProposalSinkService implements ActionItemProposalSink {
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public ActionItemProposalSinkService(JdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public Receipt acceptProposed(Batch batch) {
        validateBatch(batch);

        // Fence direct in-process misuse as well as relying on MI-10's live
        // claim verification. Do not lock/reorder Meeting/Media owner rows here.
        Boolean live = jdbc.queryForObject("""
            SELECT EXISTS(
                SELECT 1 FROM processing_stage_runs stage
                JOIN processing_jobs job ON job.id=stage.processing_job_id
                JOIN meeting_intelligence_source_snapshots snapshot
                  ON snapshot.processing_job_id=job.id
                WHERE stage.id=? AND stage.processing_job_id=?
                  AND stage.stage_code='EXTRACTING_ACTION_ITEMS'
                  AND stage.status='RUNNING' AND stage.claim_token IS NOT NULL
                  AND stage.lease_expires_at>clock_timestamp()
                  AND job.id=? AND job.meeting_id=?
                  AND snapshot.id=? AND snapshot.meeting_id=?
                  AND snapshot.transcript_id=? AND snapshot.content_revision=?
            )
            """, Boolean.class, batch.stageRunId(), batch.processingJobId(),
            batch.processingJobId(), batch.meetingId(),
            batch.sourceSnapshotId(), batch.meetingId(),
            batch.transcriptId(), batch.contentRevision());
        if (!Boolean.TRUE.equals(live)) {
            throw new IllegalStateException("Action Item acceptance requires a live stage and exact pinned source");
        }

        UUID receiptId = UUID.randomUUID();
        int inserted = jdbc.update("""
            INSERT INTO action_item_batch_receipts(
                id,meeting_id,processing_job_id,stage_run_id,source_snapshot_id,
                transcript_id,content_revision,is_stale,batch_sha256,candidate_count)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (processing_job_id,stage_run_id) DO NOTHING
            """, receiptId, batch.meetingId(), batch.processingJobId(), batch.stageRunId(),
            batch.sourceSnapshotId(), batch.transcriptId(), batch.contentRevision(),
            batch.isStale(), batch.batchSha256(), batch.candidates().size());

        // Unique conflict waits for the competing transaction. The receipt is
        // authoritative even if human editors have subsequently changed the
        // mutable Action Item title, due date, assignment or official status.
        if (inserted == 0) {
            List<StoredReceipt> existing = jdbc.query("""
                SELECT meeting_id,source_snapshot_id,transcript_id,content_revision,
                       batch_sha256,candidate_count
                  FROM action_item_batch_receipts
                 WHERE processing_job_id=? AND stage_run_id=?
                """, (rs, index) -> new StoredReceipt(
                    rs.getObject("meeting_id", UUID.class),
                    rs.getObject("source_snapshot_id", UUID.class),
                    rs.getObject("transcript_id", UUID.class),
                    rs.getLong("content_revision"),
                    rs.getString("batch_sha256"),
                    rs.getInt("candidate_count")),
                batch.processingJobId(), batch.stageRunId());
            if (existing.size() != 1 || !matches(existing.getFirst(), batch)) {
                throw new IllegalStateException("Divergent Action Item batch replay for existing stage");
            }
            // isStale is not compared: it is an advisory observation of the
            // CURRENT transcript at the acceptance time and may drift later.
            return new Receipt(true, 0);
        }

        for (Candidate candidate : batch.candidates()) {
            UUID itemId = UUID.randomUUID();
            jdbc.update("""
                INSERT INTO action_items(
                    id,meeting_id,title,details,status,assignee_user_id,due_date,
                    source_type,processing_job_id,proposal_batch_id,source_item_key,
                    transcript_id,content_revision)
                VALUES (?,?,?,?,'PROPOSED',NULL,?,'AI_EXTRACTED',?,?,?,?,?)
                """, itemId, batch.meetingId(), candidate.title(), candidate.details(),
                candidate.suggestedDueDate(), batch.processingJobId(), receiptId,
                candidate.candidateKey(), batch.transcriptId(), batch.contentRevision());
            for (UUID segmentId : candidate.evidenceSegmentIds()) {
                jdbc.update("""
                    INSERT INTO action_item_evidence(
                        action_item_id,transcript_id,transcript_segment_id)
                    VALUES (?,?,?)
                    """, itemId, batch.transcriptId(), segmentId);
            }
            jdbc.update("""
                INSERT INTO action_item_history(
                    id,action_item_id,change_type,from_value,to_value,changed_by_user_id)
                VALUES (?,?,'STATUS',NULL,'PROPOSED',NULL)
                """, UUID.randomUUID(), itemId);
        }
        // Receipt and every candidate/evidence/history row are committed in
        // the SAME PostgreSQL transaction as Media.completeStage. Even a
        // zero-candidate result has its own durable receipt.
        return new Receipt(false, batch.candidates().size());
    }

    @Override
    @Transactional(readOnly = true)
    public boolean hasAcceptedBatch(UUID processingJobId, UUID stageRunId) {
        if (processingJobId == null || stageRunId == null) return false;
        return Boolean.TRUE.equals(jdbc.queryForObject("""
            SELECT EXISTS (
                SELECT 1 FROM action_item_batch_receipts receipt
                WHERE receipt.processing_job_id=? AND receipt.stage_run_id=?
                  AND receipt.candidate_count=(
                      SELECT count(*) FROM action_items item
                       WHERE item.proposal_batch_id=receipt.id)
            )
            """, Boolean.class, processingJobId, stageRunId));
    }

    private static boolean matches(StoredReceipt stored, Batch batch) {
        return stored.meetingId().equals(batch.meetingId())
            && stored.sourceSnapshotId().equals(batch.sourceSnapshotId())
            && stored.transcriptId().equals(batch.transcriptId())
            && stored.contentRevision() == batch.contentRevision()
            && stored.batchSha256().equals(batch.batchSha256())
            && stored.candidateCount() == batch.candidates().size();
    }

    private void validateBatch(Batch batch) {
        if (batch == null || batch.meetingId() == null || batch.processingJobId() == null
                || batch.stageRunId() == null || batch.sourceSnapshotId() == null
                || batch.transcriptId() == null || batch.contentRevision() < 0
                || batch.batchSha256() == null
                || !batch.batchSha256().matches("[0-9a-f]{64}")
                || batch.candidates() == null || batch.candidates().size() > 200) {
            throw new IllegalArgumentException("Invalid Action Item batch identity/bounds");
        }
        HashSet<String> keys = new HashSet<>();
        for (Candidate c : batch.candidates()) {
            if (c == null || c.candidateKey() == null
                    || !c.candidateKey().matches("[A-Za-z0-9._-]{1,128}")
                    || !keys.add(c.candidateKey()) || c.title() == null
                    || c.title().isBlank()
                    || c.title().codePointCount(0, c.title().length()) > 500
                    || c.title().codePoints().anyMatch(Character::isISOControl)
                    || c.details() != null && (
                        c.details().codePointCount(0, c.details().length()) > 10_000
                        || hasUnsafeControls(c.details()))
                    || c.evidenceSegmentIds().isEmpty()
                    || c.evidenceSegmentIds().size() > 50
                    || c.evidenceSegmentIds().stream().anyMatch(Objects::isNull)
                    || new HashSet<>(c.evidenceSegmentIds()).size() != c.evidenceSegmentIds().size()) {
                throw new IllegalArgumentException("Invalid Action Item candidate/evidence");
            }
        }
        // Do not trust a supplied fingerprint even inside an in-process call.
        if (!ActionItemBatchFingerprint.sha256(mapper, batch.candidates()).equals(batch.batchSha256())) {
            throw new IllegalArgumentException("Action Item batch fingerprint mismatch");
        }
    }

    private static boolean hasUnsafeControls(String value) {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '\r') {
                if (i + 1 >= value.length() || value.charAt(++i) != '\n') return true;
            } else if (c != '\n' && c != '\t' && Character.isISOControl(c)) {
                return true;
            }
        }
        return false;
    }

    private record StoredReceipt(UUID meetingId, UUID sourceSnapshotId,
            UUID transcriptId, long contentRevision, String batchSha256, int candidateCount) {}
}
