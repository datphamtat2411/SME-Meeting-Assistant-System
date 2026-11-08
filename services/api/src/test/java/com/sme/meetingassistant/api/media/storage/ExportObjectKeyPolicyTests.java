package com.sme.meetingassistant.api.media.storage;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Fail-closed namespace separation before any network or filesystem effect. */
class ExportObjectKeyPolicyTests {
    private final UUID exportId = UUID.randomUUID();
    private final byte[] bytes = "trusted export boundary".getBytes(StandardCharsets.UTF_8);
    private final String digest = sha256(bytes);

    @Test
    void canonicalExportObjectKindsAreAcceptedWithExactContentTypeAndByteDigest()
            throws Exception {
        String intake = "exports/" + exportId + "/intake/" + digest + ".json";
        String snapshot = "exports/" + exportId + "/snapshots/" + "a".repeat(64) + ".json";
        String pdf = "exports/" + exportId + "/artifacts/" + digest + ".pdf";
        String markdown = "exports/" + exportId + "/artifacts/" + digest + ".md";

        ExportObjectKeyPolicy.requireImmutableWrite(intake, bytes, "application/json", digest);
        ExportObjectKeyPolicy.requireImmutableWrite(snapshot, bytes, "application/json", digest);
        ExportObjectKeyPolicy.requireImmutableWrite(pdf, bytes, "application/pdf", digest);
        ExportObjectKeyPolicy.requireImmutableWrite(markdown, bytes,
                "text/markdown; charset=UTF-8", digest);
        ExportObjectKeyPolicy.requireDownloadCapability(pdf, Duration.ofSeconds(60),
                "meeting-minutes-" + exportId + ".pdf", "application/pdf");

        assertThat(ExportObjectKeyPolicy.maximumReadBytes(intake))
                .isEqualTo(32 * 1024 * 1024);
        assertThat(ExportObjectKeyPolicy.maximumReadBytes(pdf))
                .isEqualTo(32 * 1024 * 1024);
        assertThat(ExportObjectKeyPolicy.maximumReadBytes("processing/result.json"))
                .isEqualTo(16 * 1024 * 1024);
    }

    @Test
    void mediaOperationsCannotReadSignWriteOrUnconditionallyDeleteExportObjects() {
        for (String key : new String[]{
                "exports", "exports/", "exports/" + exportId + "/artifacts/" + digest + ".pdf",
                "exports/invalid", ""}) {
            assertThatThrownBy(() -> ExportObjectKeyPolicy.denyGenericMediaOperation(key))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        ExportObjectKeyPolicy.denyGenericMediaOperation(
                "processing/" + UUID.randomUUID() + "/diarization/results/result.json");
    }

    @Test
    void invalidOrCrossTypeExportKeysAreRejected() {
        for (String key : new String[]{
                "exports/invalid",
                "exports/" + exportId + "/intake/" + digest + ".pdf",
                "exports/" + exportId + "/snapshots/" + digest + ".md",
                "exports/" + exportId + "/artifacts/" + digest + ".json",
                "exports/" + exportId + "/artifacts/../" + digest + ".pdf",
                "exports/" + exportId + "/artifacts/" + digest + ".pdf/extra",
                "exports/" + exportId.toString().toUpperCase() + "/artifacts/" + digest + ".pdf"}) {
            assertThatThrownBy(() -> ExportObjectKeyPolicy.maximumReadBytes(key))
                    .describedAs(key).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    void immutableWriteRejectsWrongDigestWrongMediaTypeAndOversizedInput() {
        String key = "exports/" + exportId + "/artifacts/" + digest + ".pdf";
        assertThatThrownBy(() -> ExportObjectKeyPolicy.requireImmutableWrite(
                key, bytes, "application/pdf", "b".repeat(64)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ExportObjectKeyPolicy.requireImmutableWrite(
                key, bytes, "text/plain", digest))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ExportObjectKeyPolicy.requireImmutableWrite(
                key, null, "application/pdf", digest))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ExportObjectKeyPolicy.requireImmutableWrite(
                key, new byte[32 * 1024 * 1024 + 1], "application/pdf", digest))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void downloadCapabilityBindsTheExactArtifactIdFormatAndDuration() {
        String key = "exports/" + exportId + "/artifacts/" + digest + ".pdf";
        assertThatThrownBy(() -> ExportObjectKeyPolicy.requireDownloadCapability(
                key, Duration.ofSeconds(60), "meeting-minutes-" + UUID.randomUUID() + ".pdf",
                "application/pdf")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ExportObjectKeyPolicy.requireDownloadCapability(
                key, Duration.ofSeconds(60), "meeting-minutes-" + exportId + ".md",
                "application/pdf")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ExportObjectKeyPolicy.requireDownloadCapability(
                key, Duration.ofSeconds(60), "meeting-minutes-" + exportId + ".pdf",
                null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ExportObjectKeyPolicy.requireDownloadCapability(
                key, Duration.ofMinutes(6), "meeting-minutes-" + exportId + ".pdf",
                "application/pdf")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ExportObjectKeyPolicy.requireDownloadCapability(
                key, Duration.ofSeconds(29), "meeting-minutes-" + exportId + ".pdf",
                "application/pdf")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void conditionalDeletionRequiresCanonicalKeyAndNonWildcardSafeEtag() {
        String key = "exports/" + exportId + "/artifacts/" + digest + ".pdf";
        ExportObjectKeyPolicy.requireConditionalDelete(key, "\"real-etag\"");
        for (String etag : new String[]{"", "*", "invalid\r\nheader", "x".repeat(257)}) {
            assertThatThrownBy(() -> ExportObjectKeyPolicy.requireConditionalDelete(key, etag))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> ExportObjectKeyPolicy.requireConditionalDelete(
                "processing/" + exportId + "/diarization/results/key", "etag"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new AssertionError(impossible);
        }
    }
}
