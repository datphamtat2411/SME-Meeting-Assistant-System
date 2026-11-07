package com.sme.meetingassistant.api.meetingexport;

import com.sme.meetingassistant.api.meetingminutes.MinutesSnapshot;
import java.util.Objects;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Transactionally admits an authorized source. S3 cannot join the PostgreSQL
 * transaction; if DB commit aborts after a successful immutable S3 PUT, only a
 * private orphan remains for DE-11 reconciliation, never a runnable empty job.
 *
 * Serialize/validate source before entry; recheck current user access in
 * ExportIntentService inside this transaction, including idempotent replay.
 */
@Service
public class ExportSubmissionService {
    private final ExportIntentService intent;
    private final ExportIntakeRepository intakes;
    private final ExportSnapshotCodec codec;
    private final ExportArtifactStore storage;

    public ExportSubmissionService(ExportIntentService intent, ExportIntakeRepository intakes,
            ExportSnapshotCodec codec, ExportArtifactStore storage) {
        this.intent = intent;
        this.intakes = intakes;
        this.codec = codec;
        this.storage = storage;
    }

    @Transactional
    public ExportRecord submit(UUID meetingId, ExportFormat format, String key,
            MinutesSnapshot snapshot) {
        Objects.requireNonNull(format, "format");
        ExportRecord record = intent.create(meetingId, format, key);
        // Replays must preserve the original frozen export even if CURRENT
        // source completeness has since changed. Authorization is rechecked.
        if (intakes.find(record.id()).isPresent()) return record;
        if (snapshot == null || snapshot.meeting() == null
                || !meetingId.equals(snapshot.meeting().id())
                || !"COMPLETE".equals(snapshot.completeness())
                || snapshot.proposalsIncluded()) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.CONFLICT,
                    "Only complete approved minutes may be exported");
        }
        byte[] intakeBytes = codec.encode(record, snapshot);
        String digest = ExportSnapshotCodec.sha256(intakeBytes);
        String objectKey = "exports/" + record.id() + "/intake/" + digest + ".json";
        storage.putVerified(objectKey, intakeBytes, "application/json", digest);
        intakes.insert(record, snapshot.sourceFingerprint(), digest, objectKey);
        return record;
    }
}
