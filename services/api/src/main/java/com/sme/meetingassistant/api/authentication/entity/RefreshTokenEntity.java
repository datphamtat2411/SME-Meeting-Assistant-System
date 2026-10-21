package com.sme.meetingassistant.api.authentication.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

@Entity
@Table(name = "refresh_tokens")
public class RefreshTokenEntity {
    @Id private UUID id;
    @Column(name = "user_id", nullable = false) private UUID userId;
    @Column(name = "token_hash", nullable = false, unique = true, length = 64) private String tokenHash;
    @Column(name = "expires_at", nullable = false) private OffsetDateTime expiresAt;
    @Column(name = "revoked_at") private OffsetDateTime revokedAt;
    @Column(name = "replaced_by") private UUID replacedBy;
    @Column(name = "created_at", nullable = false, updatable = false) private OffsetDateTime createdAt;
    protected RefreshTokenEntity() { }
    public RefreshTokenEntity(UUID userId, String tokenHash, OffsetDateTime expiresAt) {
        this.id = UUID.randomUUID(); this.userId = userId; this.tokenHash = tokenHash; this.expiresAt = expiresAt;
    }
    @PrePersist void createTimestamp() { createdAt = OffsetDateTime.now(ZoneOffset.UTC); }
    public UUID getId() { return id; }
    public UUID getUserId() { return userId; }
    public String getTokenHash() { return tokenHash; }
    public OffsetDateTime getExpiresAt() { return expiresAt; }
    public boolean isUsableAt(OffsetDateTime now) { return revokedAt == null && expiresAt.isAfter(now); }
    public void revoke(UUID replacementId) { revokedAt = OffsetDateTime.now(ZoneOffset.UTC); replacedBy = replacementId; }
}
