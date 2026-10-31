package com.sme.meetingassistant.api.meetingintelligence.service;

import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/**
 * Distinct opaque HTTP concurrency tokens for current Summary and Decision.
 * The Summary token follows the current immutable version identity, including
 * when an older candidate becomes current. It is not a meeting metadata ETag.
 */
public final class IntelligenceVersionTags {
    private IntelligenceVersionTags() { }

    public static String summary(UUID summaryVersionId, int versionNumber) {
        return summary(summaryVersionId, versionNumber, false);
    }

    /**
     * The freshness flag is part of the serialized response. A strong HTTP
     * ETag must rotate when a transcript correction first makes it stale,
     * even if the underlying Summary/Decision row version did not change.
     * Source revisions beyond that point do not change the visible projection.
     */
    public static String summary(UUID summaryVersionId, int versionNumber, boolean stale) {
        return "\"sum-" + summaryVersionId + "-" + versionNumber
            + (stale ? "-stale" : "") + "\"";
    }

    public static String decision(UUID decisionId, long rowVersion) {
        return decision(decisionId, rowVersion, false);
    }

    public static String decision(UUID decisionId, long rowVersion, boolean stale) {
        return "\"dec-" + decisionId + "-" + rowVersion
            + (stale ? "-stale" : "") + "\"";
    }

    public static void requireSummaryMatch(UUID summaryVersionId, int versionNumber, String ifMatch) {
        requireSummaryMatch(summaryVersionId, versionNumber, false, ifMatch);
    }

    public static void requireSummaryMatch(UUID summaryVersionId, int versionNumber,
            boolean stale, String ifMatch) {
        requireMatch(summary(summaryVersionId, versionNumber, stale), ifMatch);
    }

    public static void requireDecisionMatch(UUID decisionId, long rowVersion, String ifMatch) {
        requireDecisionMatch(decisionId, rowVersion, false, ifMatch);
    }

    public static void requireDecisionMatch(UUID decisionId, long rowVersion,
            boolean stale, String ifMatch) {
        requireMatch(decision(decisionId, rowVersion, stale), ifMatch);
    }

    private static void requireMatch(String current, String ifMatch) {
        if (ifMatch == null || ifMatch.isBlank()) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_REQUIRED);
        }
        if (!current.equals(ifMatch)) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
        }
    }
}
