package com.sme.meetingassistant.api.meetingexport;

import com.sme.meetingassistant.api.meetingminutes.MinutesSnapshot;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Objects;
import java.util.UUID;
import org.springframework.stereotype.Component;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;

/** Never trust object-storage data without matching the PostgreSQL intake digest. */
@Component
public final class ExportSnapshotCodec {
    public static final int MAX_INTAKE_BYTES = 8 * 1024 * 1024;
    private final ObjectMapper json;

    public ExportSnapshotCodec(ObjectMapper json) {
        this.json = json;
    }

    public record Envelope(int schemaVersion, UUID exportId, UUID meetingId,
            UUID requestedByUserId, MinutesSnapshot snapshot) { }

    public byte[] encode(ExportRecord record, MinutesSnapshot snapshot) {
        checkSnapshot(snapshot, record.meetingId());
        try {
            byte[] bytes = json.writeValueAsBytes(new Envelope(1, record.id(),
                    record.meetingId(), record.requestedByUserId(), snapshot));
            if (bytes.length == 0 || bytes.length > MAX_INTAKE_BYTES) {
                throw new IllegalArgumentException("Export intake exceeds bounded limit");
            }
            return bytes;
        } catch (JacksonException ex) {
            throw new IllegalArgumentException("Export source serialization failed", ex);
        }
    }

    public Envelope decode(byte[] bytes, ExportIntakeRepository.Intake intake,
            ExportRecord claim) {
        if (bytes == null || bytes.length < 1 || bytes.length > MAX_INTAKE_BYTES
                || !sha256(bytes).equals(intake.intakeSha256())) {
            throw new IllegalArgumentException("Invalid pinned export intake digest");
        }
        try {
            Envelope envelope = json.readValue(bytes, Envelope.class);
            if (envelope == null || envelope.schemaVersion() != 1
                    || !Objects.equals(envelope.exportId(), claim.id())
                    || !Objects.equals(envelope.meetingId(), claim.meetingId())
                    || !Objects.equals(envelope.requestedByUserId(), claim.requestedByUserId())
                    || !Objects.equals(envelope.meetingId(), intake.meetingId())
                    || !Objects.equals(envelope.requestedByUserId(), intake.requestedByUserId())
                    || !Objects.equals(intake.sourceFingerprint(),
                        envelope.snapshot() == null ? null : envelope.snapshot().sourceFingerprint())) {
                throw new IllegalArgumentException("Mismatched export source attribution");
            }
            checkSnapshot(envelope.snapshot(), claim.meetingId());
            return envelope;
        } catch (JacksonException ex) {
            throw new IllegalArgumentException("Malformed export source envelope", ex);
        }
    }

    public byte[] snapshotBytes(MinutesSnapshot snapshot) {
        checkSnapshot(snapshot, snapshot.meeting().id());
        try {
            byte[] data = json.writeValueAsBytes(snapshot);
            if (data.length < 1 || data.length > MAX_INTAKE_BYTES) {
                throw new IllegalArgumentException("Pinned snapshot is too large");
            }
            return data;
        } catch (JacksonException ex) {
            throw new IllegalArgumentException("Pinned snapshot serialization failed", ex);
        }
    }

    private void checkSnapshot(MinutesSnapshot snapshot, UUID meetingId) {
        if (snapshot == null || snapshot.schemaVersion() != 1
                || snapshot.meeting() == null
                || !Objects.equals(snapshot.meeting().id(), meetingId)
                || snapshot.proposalsIncluded()
                || !"COMPLETE".equals(snapshot.completeness())
                || snapshot.summary() == null || snapshot.transcript() == null) {
            throw new IllegalArgumentException("Incomplete or unauthorized-scope export snapshot");
        }
        try {
            MinutesSnapshot.CanonicalContent content = new MinutesSnapshot.CanonicalContent(
                    snapshot.schemaVersion(), snapshot.completeness(), snapshot.meeting(),
                    snapshot.summary(), snapshot.confirmedDecisions(),
                    snapshot.officialActionItems(), snapshot.transcript(),
                    snapshot.warnings(), snapshot.proposalsIncluded());
            String computed = sha256(json.writeValueAsBytes(content));
            if (!computed.equals(snapshot.sourceFingerprint())) {
                throw new IllegalArgumentException("Export source fingerprint mismatch");
            }
        } catch (JacksonException ex) {
            throw new IllegalArgumentException("Cannot verify canonical export source", ex);
        }
    }

    public static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(bytes));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }
}
