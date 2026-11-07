package com.sme.meetingassistant.api.meetingexport.render;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Objects;

/**
 * Immutable PDF bytes, local proof metadata and pinned-source provenance.
 * Never publish this data or private object identifiers without DE-09/10
 * authorization checks. No caller can change the digest by mutating bytes().
 */
public final class RenderedPdf {
    private final byte[] bytes;
    private final String sha256;
    private final String sourceFingerprint;
    private final String rendererVersion;
    private final int pageCount;

    public RenderedPdf(byte[] bytes, String sourceFingerprint, String rendererVersion,
            int pageCount) {
        this.bytes = Objects.requireNonNull(bytes, "bytes").clone();
        this.sourceFingerprint = Objects.requireNonNull(sourceFingerprint, "sourceFingerprint");
        this.rendererVersion = Objects.requireNonNull(rendererVersion, "rendererVersion");
        if (pageCount < 1 || this.bytes.length < 5) {
            throw new IllegalArgumentException("Invalid PDF artifact");
        }
        this.pageCount = pageCount;
        try {
            this.sha256 = HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(this.bytes));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    public byte[] bytes() { return bytes.clone(); }
    public long sizeBytes() { return bytes.length; }
    public String sha256() { return sha256; }
    public String sourceFingerprint() { return sourceFingerprint; }
    public String rendererVersion() { return rendererVersion; }
    public int pageCount() { return pageCount; }
    public String mediaType() { return "application/pdf"; }
    public String extension() { return "pdf"; }
}
