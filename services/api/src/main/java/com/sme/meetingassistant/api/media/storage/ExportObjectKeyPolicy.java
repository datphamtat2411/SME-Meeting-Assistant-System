package com.sme.meetingassistant.api.media.storage;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Shared S3 boundary for the private export namespace. Media capabilities and
 * unconditional media deletion must never become a path around export fencing.
 *
 * Export objects use server-derived canonical UUID paths. The key's suffix
 * determines content type; snapshots are keyed by source fingerprint, not by
 * the object-byte digest, so the complete byte digest is checked separately.
 */
final class ExportObjectKeyPolicy {
    static final int MAX_EXPORT_BYTES = 32 * 1024 * 1024;
    static final int MAX_RESULT_BYTES = 16 * 1024 * 1024;

    private static final Pattern KEY = Pattern.compile(
        "^exports/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/"
        + "(intake|snapshots|artifacts)/([0-9a-f]{64})[.](json|md|pdf)$");
    private static final Pattern DIGEST = Pattern.compile("^[0-9a-f]{64}$");

    private ExportObjectKeyPolicy() { }

    static boolean isExportNamespace(String key) {
        return key != null && (key.equals("exports") || key.startsWith("exports/"));
    }

    static void denyGenericMediaOperation(String key) {
        if (key == null || key.isBlank() || isExportNamespace(key)) {
            throw new IllegalArgumentException("Private export objects require the export storage boundary.");
        }
    }

    static int maximumReadBytes(String key) {
        if (key == null || key.isBlank()) {
            throw new IllegalArgumentException("Invalid private result object key");
        }
        if (isExportNamespace(key)) {
            requireKey(key);
            return MAX_EXPORT_BYTES;
        }
        return MAX_RESULT_BYTES;
    }

    static void requireImmutableWrite(String key, byte[] bytes, String contentType,
            String sha256) {
        Matcher match = requireKey(key);
        if (bytes == null || bytes.length == 0 || bytes.length > MAX_EXPORT_BYTES
                || !contentTypeFor(match).equals(contentType)
                || sha256 == null || !DIGEST.matcher(sha256).matches()
                || !sha256.equals(digest(bytes))) {
            throw new IllegalArgumentException("Invalid immutable export object");
        }
    }

    static void requireDownloadCapability(String key, Duration ttl,
            String safeFilename, String contentType) {
        Matcher match = requireKey(key);
        if (!"artifacts".equals(match.group(2))
                || ttl == null || ttl.compareTo(Duration.ofSeconds(30)) < 0
                || ttl.compareTo(Duration.ofMinutes(5)) > 0
                || !contentTypeFor(match).equals(contentType)
                || !("meeting-minutes-" + match.group(1) + "." + match.group(4))
                        .equals(safeFilename)) {
            throw new IllegalArgumentException("Invalid private export capability request");
        }
    }

    static void requireConditionalDelete(String key, String etag) {
        requireKey(key);
        if (etag == null || etag.isBlank() || etag.length() > 256
                || etag.equals("*") || etag.chars().anyMatch(c -> c < 32 || c == 127)) {
            throw new IllegalArgumentException("Invalid conditional export deletion");
        }
    }

    private static Matcher requireKey(String key) {
        Matcher match = KEY.matcher(key == null ? "" : key);
        if (!match.matches()
                || (("intake".equals(match.group(2)) || "snapshots".equals(match.group(2)))
                    && !"json".equals(match.group(4)))
                || ("artifacts".equals(match.group(2))
                    && "json".equals(match.group(4)))
                || !java.util.UUID.fromString(match.group(1)).toString().equals(match.group(1))) {
            throw new IllegalArgumentException("Invalid canonical export object key");
        }
        return match;
    }

    private static String contentTypeFor(Matcher match) {
        return switch (match.group(4)) {
            case "json" -> "application/json";
            case "md" -> "text/markdown; charset=UTF-8";
            case "pdf" -> "application/pdf";
            default -> throw new IllegalArgumentException("Invalid export object content type");
        };
    }

    private static String digest(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }
}
