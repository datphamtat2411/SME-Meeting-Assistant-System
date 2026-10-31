package com.sme.meetingassistant.api.actionitem.service;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * Action Items-owned canonical proposal acceptance contract (MI-10).
 *
 * An implementation MUST be the canonical Action Items module, own its
 * authorization, deduplication and persistence, and never treat AI input as
 * confirmation or a user assignment. No implementation is installed until
 * Action Items ownership/MI-01 G7 has been approved.
 *
 * Invoked within the orchestrator's mandatory PostgreSQL transaction after
 * trusted Media/Transcript provenance validation. Never call a remote service
 * or publish broker messages from this synchronous transactional contract.
 */
public interface ActionItemProposalSink {

    /**
     * Deterministic producer identity: processingJobId + stageRunId +
     * candidateKey. Sink MUST deduplicate replay before inserting, and\n     * reject divergent batchSha256 for the same processingJobId/stageRunId.
     */
    record Candidate(
        String candidateKey,
        String title,
        String details,
        LocalDate suggestedDueDate,
        List<UUID> evidenceSegmentIds
    ) {
        public Candidate {
            evidenceSegmentIds = evidenceSegmentIds == null
                ? List.of() : List.copyOf(evidenceSegmentIds);
        }
    }

    record Batch(
        UUID meetingId,
        UUID processingJobId,
        UUID stageRunId,
        UUID sourceSnapshotId,
        UUID transcriptId,
        long contentRevision,
        boolean isStale,
        String batchSha256,
        List<Candidate> candidates
    ) {
        public Batch {
            candidates = candidates == null ? List.of() : List.copyOf(candidates);
        }
    }

    /**
     * Persist ONLY AI_EXTRACTED/PROPOSED candidates and their evidence.
     * Never supply a client-provided canonical row ID, actor, assignee or
     * OPEN/CONFIRMED/DONE status. A zero-candidate batch is a valid accepted
     * extraction and must be recorded idempotently by the owning module.
     *
     * Returns the number of *new* canonical proposals and whether the
     * entire batch was previously accepted unchanged. Divergent replay
     * MUST raise an exception and roll back.
     */
    record Receipt(boolean replay, int newProposals) {}

    Receipt acceptProposed(Batch batch);

    /**
     * Read-only canonical, durable (or same-transaction) acceptance evidence.
     * A zero-item batch still requires an accepted receipt. The Action Items
     * owner implements this query against its own transactional persistence.
     */
    boolean hasAcceptedBatch(UUID processingJobId, UUID stageRunId);
}
