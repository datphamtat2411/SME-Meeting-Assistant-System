package com.sme.meetingassistant.api.transcript.service;

import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/** Canonical opaque concurrency tokens for transcript resources. */
public final class TranscriptVersionTags {
    private TranscriptVersionTags() {}

    public static String transcript(UUID transcriptId, long revision) {
        return "\"t-" + transcriptId + "-" + revision + "\"";
    }

    public static String segment(UUID segmentId, long version) {
        return "\"s-" + segmentId + "-" + version + "\"";
    }

    public static long requireSegmentMatch(UUID segmentId, String ifMatch) {
        if (ifMatch == null || ifMatch.isBlank()) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_REQUIRED);
        }
        String prefix = segment(segmentId, 0).replace("-0\"", "-");
        if (!ifMatch.startsWith(prefix) || !ifMatch.endsWith("\"")) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
        }
        try {
            long version = Long.parseLong(ifMatch.substring(prefix.length(), ifMatch.length() - 1));
            if (version < 0) throw new NumberFormatException();
            return version;
        } catch (NumberFormatException error) {
            throw new ResponseStatusException(HttpStatus.PRECONDITION_FAILED);
        }
    }
}
