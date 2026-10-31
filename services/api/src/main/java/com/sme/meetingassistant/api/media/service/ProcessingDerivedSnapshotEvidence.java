package com.sme.meetingassistant.api.media.service;
import java.util.UUID;

/** Media's minimal read-only port: MI owns source snapshots and receipt rows. */
public interface ProcessingDerivedSnapshotEvidence {
    boolean hasPinnedSummarySource(UUID jobId);
    boolean hasAcceptedSummary(UUID jobId);
    /** Canonical acceptance for the exact stage attempt; empty batches require receipts. */
    boolean hasAcceptedResultForStage(UUID jobId, UUID stageRunId, String stageCode);
}
