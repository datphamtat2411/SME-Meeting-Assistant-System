package com.sme.meetingassistant.api.common;

import java.util.Map;
import java.util.Set;

/**
 * Persist only small, typed processing diagnostics. Raw ASR candidates,
 * prompts, transcripts, model responses and arbitrary provider payloads are
 * forbidden in durable stage/segment/coverage metadata (AI-AUTHORITY-001).
 *
 * Extend these keys through a reviewed schema contract, not arbitrary JSON.
 */
public final class SafeAiDiagnostics {
    private SafeAiDiagnostics() {}

    public static void stageMetrics(Map<String, Object> metrics) {
        if (metrics == null) return;
        small(metrics, 20);
        metrics.forEach((key, value) -> {
            switch (key) {
                case "validated", "speech_coverage_validated", "coverageValidated",
                     "persisted", "recovered" -> bool(value);
                case "coverage", "coverageRatio", "confidence", "asrConfidence",
                     "diarizationConfidence" -> ratio(value);
                case "durationMs", "speechDurationMs", "providerLatencyMs", "retryCount",
                     "attemptCount", "segmentCount", "chunkCount", "warningCount",
                     "unresolvedRegionCount" -> nonnegativeInteger(value);
                case "contextScope" -> {
                    if (!"WHOLE_MEETING".equals(value)) reject();
                }
                case "outputSha256" -> {
                    if (!(value instanceof String str) || !str.matches("[0-9a-f]{64}")) reject();
                }
                case "promptVersion" -> {
                    if (!(value instanceof String str)
                            || !str.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,79}")) reject();
                }
                default -> reject();
            }
        });
    }

    public static void segmentConfidence(Map<String, Object> metadata) {
        if (metadata == null) return;
        small(metadata, 12);
        metadata.forEach((key, value) -> {
            switch (key) {
                case "confidence", "asrConfidence", "diarizationConfidence",
                     "languageConfidence" -> ratio(value);
                case "recovered" -> bool(value);
                case "retryCount" -> nonnegativeInteger(value);
                case "qualityScores" -> {
                    if (!(value instanceof Map<?, ?> scores) || scores.size() > 4) reject();
                    for (var entry : scores.entrySet()) {
                        if (!(entry.getKey() instanceof String name)
                                || !Set.of("speech", "speaker", "language", "alignment").contains(name)) reject();
                        ratio(entry.getValue());
                    }
                }
                default -> reject();
            }
        });
    }

    public static void coverageMetadata(Map<String, Object> metadata) {
        if (metadata == null) return;
        small(metadata, 12);
        metadata.forEach((key, value) -> {
            switch (key) {
                case "accepted", "recovered", "vadDetected", "energyDetected" -> bool(value);
                case "coverageRatio", "vadConfidence", "energyConfidence" -> ratio(value);
                case "retryCount", "speechDurationMs", "unresolvedRegionCount" -> nonnegativeInteger(value);
                default -> reject();
            }
        });
    }

    private static void small(Map<?, ?> metadata, int maximum) {
        if (metadata.size() > maximum || metadata.containsKey(null)) reject();
    }

    private static void bool(Object value) {
        if (!(value instanceof Boolean)) reject();
    }

    private static void ratio(Object value) {
        if (!(value instanceof Number n) || !Double.isFinite(n.doubleValue())
                || n.doubleValue() < 0.0 || n.doubleValue() > 1.0) reject();
    }

    private static void nonnegativeInteger(Object value) {
        if (!(value instanceof Number n) || !Double.isFinite(n.doubleValue())
                || n.doubleValue() < 0.0 || n.doubleValue() > Long.MAX_VALUE
                || n.doubleValue() != Math.rint(n.doubleValue())) reject();
    }

    private static void reject() {
        // Never echo a rejected value into HTTP responses or routine logs.
        throw new IllegalArgumentException("Only approved, typed AI diagnostics may be persisted.");
    }
}
