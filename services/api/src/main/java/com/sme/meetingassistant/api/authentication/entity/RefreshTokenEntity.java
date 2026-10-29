package com.sme.meetingassistant.api.authentication.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.OffsetDateTime;
import java.util.Objects;
import java.util.UUID;

/**
 * Hashed opaque refresh verifier, linked to a single auth_sessions family.
 * Consumption, explicit revocation and replacement lineage remain distinct.
 */
@Entity
@Table(name = "refresh_tokens")
public class RefreshTokenEntity {
    @Id
    private UUID id;
    @Column(name = "session_id", nullable = false, updatable = false)
    private UUID sessionId;
    @Column(name = "token_hash", nullable = false, unique = true, columnDefinition = "TEXT", updatable = false)
    private String tokenHash;
    @Column(name = "issued_at", nullable = false, updatable = false)
    private OffsetDateTime issuedAt;
    @Column(name = "expires_at", nullable = false, updatable = false)
    private OffsetDateTime expiresAt;
    @Column(name = "consumed_at")
    private OffsetDateTime consumedAt;
    @Column(name = "revoked_at")
    private OffsetDateTime revokedAt;
    @Column(name = "replaced_by_token_id")
    private UUID replacedByTokenId;

    protected RefreshTokenEntity() { }

    public RefreshTokenEntity(UUID sessionId, String tokenHash,
            OffsetDateTime issuedAt, OffsetDateTime expiresAt) {
        this.id = UUID.randomUUID();
        this.sessionId = Objects.requireNonNull(sessionId, "sessionId");
        this.tokenHash = requireHash(tokenHash);
        this.issuedAt = Objects.requireNonNull(issuedAt, "issuedAt");
        this.expiresAt = Objects.requireNonNull(expiresAt, "expiresAt");
        if (!expiresAt.isAfter(issuedAt)) throw new IllegalArgumentException("Invalid token expiry");
    }

    private static String requireHash(String hash) {
        if (hash == null || !hash.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("Expected 64-character SHA-256 verifier");
        }
        return hash;
    }

    /** Caller must hold a transactional lock on the presented token record. */
    public void consume(OffsetDateTime at, UUID replacementId) {
        if (consumedAt != null || revokedAt != null || !expiresAt.isAfter(at)) {
            throw new IllegalStateException("Refresh token already consumed, revoked or expired");
        }
        if (replacementId == null || id.equals(replacementId)) {
            throw new IllegalArgumentException("A distinct replacement token is required");
        }
        consumedAt = at;
        replacedByTokenId = replacementId;
    }

    public void revoke(OffsetDateTime at) {
        if (revokedAt == null) revokedAt = Objects.requireNonNull(at, "at");
    }

    public UUID getId() { return id; }
    public UUID getSessionId() { return sessionId; }
    public String getTokenHash() { return tokenHash; }
    public OffsetDateTime getIssuedAt() { return issuedAt; }
    public OffsetDateTime getExpiresAt() { return expiresAt; }
    public OffsetDateTime getConsumedAt() { return consumedAt; }
    public OffsetDateTime getRevokedAt() { return revokedAt; }
    public UUID getReplacedByTokenId() { return replacedByTokenId; }
}
