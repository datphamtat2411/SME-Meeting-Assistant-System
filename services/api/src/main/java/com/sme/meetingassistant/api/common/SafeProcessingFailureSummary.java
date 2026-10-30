package com.sme.meetingassistant.api.common;

/**
 * Closed, Core-owned presentation summaries for worker failures.
 * The raw worker/provider diagnostic message must never enter durable job state.
 * Keep detail in approved non-sensitive metrics and controlled error codes.
 */
public final class SafeProcessingFailureSummary {
    private SafeProcessingFailureSummary() {}

    public static String forCode(String errorCode) {
        return switch (errorCode) {
            case "STAGE_LEASE_EXPIRED" -> "Processing worker stopped reporting progress.";
            case "ASR_FAILED", "TRANSCRIPTION_TEMPORARY" -> "Audio transcription failed.";
            case "LLM_CORRECTION_FAILED" -> "Whole-meeting contextual correction failed.";
            case "SUMMARY_FAILED", "SUMMARY_PROVIDER_FAILURE" -> "Meeting summary processing failed.";
            case "PROCESSING_DISPATCH_FAILED" -> "Processing job dispatch failed.";
            default -> "Processing stage failed.";
        };
    }
}
