package com.sme.meetingassistant.api.media.service;

import java.util.UUID;

/** Source owner port. Preparation performs remote I/O without a business transaction. */
public interface ProcessingIntelligenceSource {
    record Snapshot(UUID snapshotId,UUID transcriptId,long contentRevision,String objectKey,String sha256,long sizeBytes) {}
    Snapshot prepare(UUID jobId,UUID meetingId,UUID mediaId,boolean derived);
    /** Caller holds Meeting before Job. No storage I/O; reject a changed binding. */
    void requireBinding(UUID jobId,UUID meetingId,UUID mediaId,boolean derived,Snapshot expected);
}
