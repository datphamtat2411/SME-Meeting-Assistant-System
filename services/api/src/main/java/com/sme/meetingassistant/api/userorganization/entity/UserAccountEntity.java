package com.sme.meetingassistant.api.userorganization.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

@Entity
@Table(name = "user_accounts")
public class UserAccountEntity {
    @Id private UUID id;
    @Column(nullable = false, length = 320) private String email;
    @Column(name = "normalized_email", nullable = false, unique = true, length = 320) private String normalizedEmail;
    @Column(name = "password_hash", nullable = false, length = 100) private String passwordHash;
    @Column(name = "display_name", nullable = false, length = 120) private String displayName;
    @Enumerated(EnumType.STRING) @Column(nullable = false, length = 20) private UserAccountStatus status = UserAccountStatus.ACTIVE;
    @Version @Column(nullable = false) private long version;
    @Column(name = "created_at", nullable = false, updatable = false) private OffsetDateTime createdAt;
    @Column(name = "updated_at", nullable = false) private OffsetDateTime updatedAt;

    protected UserAccountEntity() { }

    public UserAccountEntity(String email, String normalizedEmail, String passwordHash, String displayName) {
        this.id = UUID.randomUUID(); this.email = email; this.normalizedEmail = normalizedEmail;
        this.passwordHash = passwordHash; this.displayName = displayName;
    }

    @PrePersist void createTimestamps() { var now = OffsetDateTime.now(ZoneOffset.UTC); createdAt = now; updatedAt = now; }
    @PreUpdate void updateTimestamp() { updatedAt = OffsetDateTime.now(ZoneOffset.UTC); }
    public UUID getId() { return id; }
    public String getEmail() { return email; }
    public String getNormalizedEmail() { return normalizedEmail; }
    public String getPasswordHash() { return passwordHash; }
    public String getDisplayName() { return displayName; }
    public UserAccountStatus getStatus() { return status; }
    public long getVersion() { return version; }
    public OffsetDateTime getCreatedAt() { return createdAt; }
    public void updateProfile(String displayName) { this.displayName = displayName; }
    public void changePasswordHash(String passwordHash) { this.passwordHash = passwordHash; }
    public void disable() { this.status = UserAccountStatus.DISABLED; }
}
