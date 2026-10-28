package com.sme.meetingassistant.api.authentication.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.OffsetDateTime;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

/** Revocable login session/refresh family; not a servlet HttpSession. */
@Entity
@Table(name = "auth_sessions")
public class AuthSessionEntity {
    @Id
    private UUID id;
    @Column(name = "user_id", nullable = false, updatable = false)
    private UUID userId;
    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 24)
    private AuthSessionStatus status;
    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;
    @Column(name = "last_seen_at")
    private OffsetDateTime lastSeenAt;
    @Column(name = "absolute_expires_at", nullable = false, updatable = false)
    private OffsetDateTime absoluteExpiresAt;
    @Column(name = "revoked_at")
    private OffsetDateTime revokedAt;
    @Column(name = "revoke_reason", length = 64)
    private String revokeReason;
    @Enumerated(EnumType.STRING)
    @Column(name = "client_type", nullable = false, length = 24, updatable = false)
    private AuthClientType clientType;
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "client_metadata", columnDefinition = "jsonb")
    private Map<String, String> clientMetadata;

    protected AuthSessionEntity() { }

    public AuthSessionEntity(UUID userId, AuthClientType clientType,
            OffsetDateTime createdAt, OffsetDateTime absoluteExpiresAt,
            Map<String, String> clientMetadata) {
        this.id = UUID.randomUUID();
        this.userId = Objects.requireNonNull(userId, "userId");
        this.clientType = Objects.requireNonNull(clientType, "clientType");
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt");
        this.absoluteExpiresAt = Objects.requireNonNull(absoluteExpiresAt, "absoluteExpiresAt");
        if (!absoluteExpiresAt.isAfter(createdAt)
                || absoluteExpiresAt.isAfter(createdAt.plusDays(30))) {
            throw new IllegalArgumentException("Session absolute lifetime must be within 30 days");
        }
        this.status = AuthSessionStatus.ACTIVE;
        this.clientMetadata = clientMetadata == null ? null : Map.copyOf(clientMetadata);
    }

    public void recordActivity(OffsetDateTime at) {
        if (status != AuthSessionStatus.ACTIVE || !at.isBefore(absoluteExpiresAt)) {
            throw new IllegalStateException("Inactive or expired session");
        }
        if (at.isBefore(createdAt)) throw new IllegalArgumentException("Activity precedes session creation");
        if (lastSeenAt == null || at.isAfter(lastSeenAt)) lastSeenAt = at;
    }

    public void revoke(OffsetDateTime at, String reason) {
        if (status != AuthSessionStatus.ACTIVE) return;
        Objects.requireNonNull(at, "at");
        if (reason == null || reason.isBlank() || reason.length() > 64) {
            throw new IllegalArgumentException("Stable revoke reason required");
        }
        this.status = AuthSessionStatus.REVOKED;
        this.revokedAt = at;
        this.revokeReason = reason;
    }

    public void expire() {
        if (status != AuthSessionStatus.ACTIVE) return;
        this.status = AuthSessionStatus.EXPIRED;
    }

    public UUID getId() { return id; }
    public UUID getUserId() { return userId; }
    public AuthSessionStatus getStatus() { return status; }
    public OffsetDateTime getCreatedAt() { return createdAt; }
    public OffsetDateTime getLastSeenAt() { return lastSeenAt; }
    public OffsetDateTime getAbsoluteExpiresAt() { return absoluteExpiresAt; }
    public OffsetDateTime getRevokedAt() { return revokedAt; }
    public String getRevokeReason() { return revokeReason; }
    public AuthClientType getClientType() { return clientType; }
    public Map<String, String> getClientMetadata() {
        return clientMetadata == null ? null : Map.copyOf(clientMetadata);
    }
}
