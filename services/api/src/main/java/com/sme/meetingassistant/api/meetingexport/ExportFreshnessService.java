package com.sme.meetingassistant.api.meetingexport;

import com.sme.meetingassistant.api.meetingminutes.MinutesAssembler;
import java.time.OffsetDateTime;
import java.util.Objects;
import org.springframework.stereotype.Service;

/**
 * DE-11: compare an immutable READY export's canonical source fingerprint
 * with the current, meeting-authorized and repeatable-read Minutes snapshot.
 *
 * Never query Minutes from a background worker: authorization belongs to the
 * CURRENT caller. No DB mutation, PDF regeneration or S3 rewriting occurs.
 */
@Service
public final class ExportFreshnessService {
    private final MinutesAssembler minutes;

    public ExportFreshnessService(MinutesAssembler minutes) {
        this.minutes = minutes;
    }

    public enum Freshness { CURRENT, STALE, NOT_APPLICABLE, UNKNOWN }

    public record FreshnessEvidence(Freshness freshness, OffsetDateTime checkedAt) { }

    public FreshnessEvidence evaluate(ExportRecord record) {
        if (record.status() != ExportStatus.READY) {
            return new FreshnessEvidence(Freshness.NOT_APPLICABLE, null);
        }
        // Called AFTER the same request has passed Meeting-content authorization.
        // The assembler independently authorizes before every source read.
        var current = minutes.current(record.meetingId());
        if (current == null || record.sourceFingerprint() == null
                || current.sourceFingerprint() == null) {
            return new FreshnessEvidence(Freshness.UNKNOWN, null);
        }
        return new FreshnessEvidence(
                Objects.equals(record.sourceFingerprint(), current.sourceFingerprint())
                    ? Freshness.CURRENT : Freshness.STALE,
                current.assembledAt());
    }
}
