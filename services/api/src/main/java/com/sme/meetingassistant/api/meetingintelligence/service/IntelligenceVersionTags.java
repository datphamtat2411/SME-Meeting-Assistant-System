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
        return "\"sum-" + summaryVersionId + "-" + versionNumber + "\"";
    }

    public static String decision(UUID decisionId, long rowVersion) {
        return "\"dec-" + decisionId + "-" + rowVersion + "\"";
    }

    public static void requireSummaryMatch(UUID summaryVersionId, int versionNumber, String ifMatch) {
        requireMatch(summary(summaryVersionId, versionNumber), ifMatch);
    }

    public static void requireDecisionMatch(UUID decisionId, long rowVersion, String ifMatch) {
        requireMatch(decision(decisionId, rowVersion), ifMatch);
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
