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

    // Intake v1 selects the original renderers; v2 selects name-enriched renderers.
    // The intake digest pins this decision before the worker can claim a job.
    public static final int LEGACY_INTAKE_VERSION = 1;
    public static final int CURRENT_INTAKE_VERSION = 2;

    public record Envelope(int schemaVersion, UUID exportId, UUID meetingId,
            UUID requestedByUserId, MinutesSnapshot snapshot) { }

    public byte[] encode(ExportRecord record, MinutesSnapshot snapshot) {
        checkSnapshot(snapshot, record.meetingId());
        try {
            byte[] bytes = json.writeValueAsBytes(new Envelope(CURRENT_INTAKE_VERSION, record.id(),
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
            if (envelope == null || (envelope.schemaVersion() != LEGACY_INTAKE_VERSION
                        && envelope.schemaVersion() != CURRENT_INTAKE_VERSION)
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

    /**
     * Called only after decode has verified the exact frozen intake digest and
     * canonical source. V2 preserves the JSON field/map order from that intake:
     * Map.copyOf iteration order can vary across JVMs, but immutable storage keys
     * must survive worker restarts. V1 retains its original serialization path.
     */
    byte[] snapshotBytes(Envelope verified, byte[] frozenIntake) {
        if (verified.schemaVersion() == LEGACY_INTAKE_VERSION) {
            return snapshotBytes(verified.snapshot());
        }
        if (verified.schemaVersion() != CURRENT_INTAKE_VERSION) {
            throw new IllegalArgumentException("Unsupported export intake version");
        }
        try {
            var node = json.readTree(frozenIntake).path("snapshot");
            if (!node.isObject()) throw new IllegalArgumentException("Missing pinned snapshot");
            byte[] data = json.writeValueAsBytes(node);
            if (data.length < 1 || data.length > MAX_INTAKE_BYTES) {
                throw new IllegalArgumentException("Pinned snapshot is too large");
            }
            return data;
        } catch (JacksonException ex) {
            throw new IllegalArgumentException("Pinned snapshot serialization failed", ex);
        }
    }

    /**
     * Compare complete JSON (including display metadata and timestamps), not
     * just the canonical fingerprint. Duplicate fields and trailing content
     * are never accepted as an equivalent historical snapshot.
     */
    boolean sameLegacySnapshot(byte[] expected, byte[] observed) {
        try {
            var reader = json.readerFor(tools.jackson.databind.JsonNode.class)
                    .with(tools.jackson.databind.DeserializationFeature.FAIL_ON_READING_DUP_TREE_KEY)
                    .with(tools.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
            tools.jackson.databind.JsonNode left = reader.readValue(expected);
            tools.jackson.databind.JsonNode right = reader.readValue(observed);
            return left != null && left.isObject() && left.equals(right);
        } catch (JacksonException ex) {
            return false;
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
                 || !java.util.Set.of("COMPLETE","PARTIAL","NEEDS_REVIEW").contains(snapshot.completeness())
                 || snapshot.proposalsIncluded()!=!snapshot.draftProposals().isEmpty()
                 || !snapshot.hasUsableContent()
                || snapshot.summary() == null || snapshot.transcript() == null) {
            throw new IllegalArgumentException("Incomplete or unauthorized-scope export snapshot");
        }
        try {
            MinutesSnapshot.CanonicalContent content = new MinutesSnapshot.CanonicalContent(
                    snapshot.schemaVersion(), snapshot.completeness(), snapshot.meeting(),
                    snapshot.summary(), snapshot.confirmedDecisions(),
                    snapshot.officialActionItems(), snapshot.transcript(),
                     snapshot.warnings(), snapshot.proposalsIncluded(), snapshot.draftProposals());
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
