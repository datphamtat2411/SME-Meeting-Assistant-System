package com.sme.meetingassistant.api.meetingexport;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/** Strict internal naming. Never accept a caller-provided S3 key or claim token. */
final class ExportDigests {
    private static final Pattern DIGEST = Pattern.compile("[0-9a-f]{64}");
    private static final Pattern KEY = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}");
    private static final Pattern RENDERER = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]{0,63}");

    private ExportDigests() { }

    static String requireKey(String key) {
        if (key == null || !KEY.matcher(key).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid Idempotency-Key");
        }
        return key;
    }

    static String requireDigest(String digest) {
        if (digest == null || !DIGEST.matcher(digest).matches()) {
            throw new IllegalArgumentException("Invalid SHA-256 fingerprint");
        }
        return digest;
    }

    static String requireRenderer(String value) {
        if (value == null || !RENDERER.matcher(value).matches()) {
            throw new IllegalArgumentException("Invalid renderer version");
        }
        return value;
    }

    static String keyDigest(UUID meetingId, String key) {
        return sha256("POST /api/v1/meetings/" + meetingId + "/exports\n" + requireKey(key));
    }

    static String requestDigest(UUID meetingId, ExportFormat format) {
        return sha256("de06-intent-v1\n" + meetingId + "\n" + format.name()
                + "\nincludeProposals=false");
    }

    static String snapshotKey(UUID exportId, String fingerprint) {
        return "exports/" + exportId + "/snapshots/" + requireDigest(fingerprint) + ".json";
    }

    static String artifactKey(UUID exportId, ExportFormat format, String digest) {
        return "exports/" + exportId + "/artifacts/" + requireDigest(digest)
                + "." + format.extension();
    }

    private static String sha256(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(bytes);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 digest unavailable", impossible);
        }
    }
}
