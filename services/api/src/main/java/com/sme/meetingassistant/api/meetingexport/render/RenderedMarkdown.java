package com.sme.meetingassistant.api.meetingexport.render;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Objects;

/**
 * Immutable UTF-8 Markdown artifact. Bytes are defensively copied to keep
 * verified payload content stable across worker/storage handoffs.
 */
public final class RenderedMarkdown {
    private final byte[] utf8;
    private final String sha256;
    private final String sourceFingerprint;
    private final String rendererVersion;

    public RenderedMarkdown(byte[] utf8, String sourceFingerprint,
            String rendererVersion) {
        this.utf8 = Objects.requireNonNull(utf8, "utf8").clone();
        this.sourceFingerprint = Objects.requireNonNull(sourceFingerprint, "sourceFingerprint");
        this.rendererVersion = Objects.requireNonNull(rendererVersion, "rendererVersion");
        try {
            this.sha256 = HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(this.utf8));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    public byte[] utf8() { return utf8.clone(); }
    public String text() { return new String(utf8, StandardCharsets.UTF_8); }
    public long sizeBytes() { return utf8.length; }
    public String sha256() { return sha256; }
    public String sourceFingerprint() { return sourceFingerprint; }
    public String rendererVersion() { return rendererVersion; }
    public String mediaType() { return "text/markdown; charset=UTF-8"; }
    public String extension() { return "md"; }
}
