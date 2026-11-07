package com.sme.meetingassistant.api.actionitem.service;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import tools.jackson.databind.ObjectMapper;

/**
 * MI-10 v1 fingerprint: SHA-256 of the exact JSON serialization of the
 * ordered candidate list, including ordered evidence IDs. Shared between the
 * trusted handoff and the canonical Action Items consumer to prevent forgery
 * or accidental producer/consumer drift. Changing this algorithm is a versioned
 * internal contract change, never an incidental refactor.
 */
public final class ActionItemBatchFingerprint {
    private ActionItemBatchFingerprint() {}

    public static String sha256(ObjectMapper mapper,
            List<ActionItemProposalSink.Candidate> candidates) {
        Objects.requireNonNull(mapper, "mapper");
        Objects.requireNonNull(candidates, "candidates");
        byte[] bytes = mapper.writeValueAsBytes(candidates);
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }
}
