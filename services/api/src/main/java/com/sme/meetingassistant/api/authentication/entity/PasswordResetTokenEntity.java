package com.sme.meetingassistant.api.authentication.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.OffsetDateTime;
import java.util.Objects;
import java.util.UUID;

/** One-purpose, single-use password recovery verifier; unrelated to account setup tokens. */
@Entity
@Table(name = "password_reset_tokens")
public class PasswordResetTokenEntity {
    @Id
    private UUID id;
    @Column(name = "user_id", nullable = false, updatable = false)
    private UUID userId;
    @Column(name = "token_hash", nullable = false, unique = true, columnDefinition = "TEXT", updatable = false)
    private String tokenHash;
    @Column(name = "requested_at", nullable = false, updatable = false)
    private OffsetDateTime requestedAt;
    @Column(name = "expires_at", nullable = false, updatable = false)
    private OffsetDateTime expiresAt;
    @Column(name = "used_at")
    private OffsetDateTime usedAt;
    @Column(name = "revoked_at")
    private OffsetDateTime revokedAt;

    protected PasswordResetTokenEntity() { }

    public PasswordResetTokenEntity(UUID userId, String tokenHash,
            OffsetDateTime requestedAt, OffsetDateTime expiresAt) {
        this.id = UUID.randomUUID();
        this.userId = Objects.requireNonNull(userId, "userId");
        if (tokenHash == null || !tokenHash.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("Expected 64-character recovery verifier");
        }
        this.tokenHash = tokenHash;
        this.requestedAt = Objects.requireNonNull(requestedAt, "requestedAt");
        this.expiresAt = Objects.requireNonNull(expiresAt, "expiresAt");
        if (!expiresAt.isAfter(requestedAt)
                || expiresAt.isAfter(requestedAt.plusMinutes(30))) {
            throw new IllegalArgumentException("Password reset authorization is limited to 30 minutes");
        }
    }

    public void consume(OffsetDateTime at) {
        if (usedAt != null || revokedAt != null || !expiresAt.isAfter(at)) {
            throw new IllegalStateException("Reset capability already consumed, revoked or expired");
        }
        usedAt = at;
    }

    public void revoke(OffsetDateTime at) {
        if (revokedAt == null) revokedAt = Objects.requireNonNull(at, "at");
    }

    public UUID getId() { return id; }
    public UUID getUserId() { return userId; }
    public String getTokenHash() { return tokenHash; }
    public OffsetDateTime getRequestedAt() { return requestedAt; }
    public OffsetDateTime getExpiresAt() { return expiresAt; }
    public OffsetDateTime getUsedAt() { return usedAt; }
    public OffsetDateTime getRevokedAt() { return revokedAt; }
}
