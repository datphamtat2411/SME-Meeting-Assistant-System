package com.sme.meetingassistant.api.authentication.service;

import com.sme.meetingassistant.api.authentication.entity.AuthClientType;
import java.time.OffsetDateTime;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Internal token rotation and revocation boundary.
 *
 * A rotation replay must commit the session-family revocation before rejecting the
 * caller. Keep HTTP transport (Web cookies/CSRF and Mobile credentials) in P4-T05.
 */
@Service
public class RefreshSessionService {
    private final RefreshSessionTransaction transactions;

    public RefreshSessionService(RefreshSessionTransaction transactions) {
        this.transactions = transactions;
    }

    public RotatedRefresh rotate(String presentedToken, AuthClientType trustedClientType) {
        if (trustedClientType == null || presentedToken == null
                || !presentedToken.matches("[A-Za-z0-9_-]{64}")) {
            throw rejected();
        }
        var outcome = transactions.rotate(presentedToken, trustedClientType);
        if (outcome == null) {
            // Replay revocation (or expiry) has already committed.
            throw rejected();
        }
        return outcome;
    }

    /**
     * Caller must supply a verified user/session identity, never caller-controlled UUIDs.
     * Idempotent for repeated requests and for sessions which have already expired.
     */
    public void logout(UUID authenticatedUserId, UUID authenticatedSessionId) {
        if (authenticatedUserId == null || authenticatedSessionId == null) {
            throw rejected();
        }
        transactions.revokeCurrent(authenticatedUserId, authenticatedSessionId);
    }

    /**
     * P4-T08 / PR #3 T05 integration point: call in the same transaction as an account
     * status/role/scope change, after obtaining the canonical user lock.
     * No cross-PR integration is attempted here.
     */
    public int revokeAllForUser(UUID userId, String reason) {
        if (userId == null) throw new IllegalArgumentException("userId is required");
        return transactions.revokeAllForUser(userId, reason);
    }

    private static ResponseStatusException rejected() {
        return new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid refresh credentials");
    }

    public record RotatedRefresh(UUID userId, UUID sessionId, AuthClientType clientType,
                                 String refreshToken, OffsetDateTime refreshExpiresAt,
                                 OffsetDateTime absoluteSessionExpiresAt) {}
}
