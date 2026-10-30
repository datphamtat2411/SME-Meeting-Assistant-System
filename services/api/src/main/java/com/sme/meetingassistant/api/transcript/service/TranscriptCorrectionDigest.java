package com.sme.meetingassistant.api.transcript.service;

import com.sme.meetingassistant.api.transcript.service.TranscriptIngestion.TranscriptResult;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Comparator;
import java.util.HexFormat;

/**
 * Stable cross-service digest contract for context-corrected transcript output.
 * SHA-256("SME-CONTEXTUAL-CORRECTION-V1\\0" in UTF-8 followed by segments
 * sorted by ordinal; each segment is big-endian int32 ordinal, int64 startMs,
 * int64 endMs, int32 UTF-8 byte count, then the exact corrected UTF-8 bytes).
 * No raw ASR candidates, provider payloads or private text are persisted here.
 */
public final class TranscriptCorrectionDigest {
    private TranscriptCorrectionDigest() {}

    public static String sha256(TranscriptResult result) {
        if (result == null || result.segments() == null) {
            throw new IllegalArgumentException("Transcript segments are required.");
        }
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update("SME-CONTEXTUAL-CORRECTION-V1\0".getBytes(StandardCharsets.UTF_8));
            for (var segment : result.segments().stream()
                    .sorted(Comparator.comparingInt(s -> s.ordinal())).toList()) {
                byte[] text = segment.text().getBytes(StandardCharsets.UTF_8);
                md.update(ByteBuffer.allocate(24).putInt(segment.ordinal())
                    .putLong(segment.startMs()).putLong(segment.endMs())
                    .putInt(text.length).array());
                md.update(text);
            }
            return HexFormat.of().formatHex(md.digest());
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 unavailable.", exception);
        }
    }
}
