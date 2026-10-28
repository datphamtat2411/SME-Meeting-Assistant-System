package com.sme.meetingassistant.api.userorganization.entity;

import com.sme.meetingassistant.api.userorganization.service.EmailNormalizer;
import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Objects;
import java.util.UUID;

/** Canonical organizational identity. Account activation and session policy are implemented in T04/T05. */
@Entity
@Table(name = "users")
public class UserEntity {
    @Id
    private UUID id;

    @Column(name = "email", nullable = false, length = 320)
    private String email;

    @Column(name = "email_normalized", nullable = false, unique = true, length = 320)
    private String emailNormalized;

    @Column(name = "display_name", nullable = false, length = 200)
    private String displayName;

    @Column(name = "password_hash", columnDefinition = "TEXT")
    private String passwordHash;

    @Enumerated(EnumType.STRING)
    @Column(name = "global_role", nullable = false, length = 32)
    private GlobalRole globalRole;

    @Enumerated(EnumType.STRING)
    @Column(name = "account_status", nullable = false, length = 32)
    private AccountStatus accountStatus = AccountStatus.PENDING_SETUP;

    @Column(name = "primary_org_unit_id")
    private UUID primaryOrgUnitId;

    @Column(name = "credential_changed_at")
    private OffsetDateTime credentialChangedAt;

    @Column(name = "last_login_at")
    private OffsetDateTime lastLoginAt;

    @Column(name = "deactivated_at")
    private OffsetDateTime deactivatedAt;

    @Version
    @Column(name = "version", nullable = false)
    private long version;

    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;

    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt;

    protected UserEntity() { }

    /** New organizational accounts are provisioned pending a secure setup flow (SEC-ACC-005). */
    public UserEntity(String email, String displayName, GlobalRole globalRole, UUID primaryOrgUnitId) {
        this.id = UUID.randomUUID();
        setEmail(email);
        renameDisplayName(displayName);
        this.globalRole = Objects.requireNonNull(globalRole, "globalRole");
        this.primaryOrgUnitId = primaryOrgUnitId;
    }

    @PrePersist
    void onCreate() {
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        createdAt = now;
        updatedAt = now;
    }

    @PreUpdate
    void onUpdate() {
        updatedAt = OffsetDateTime.now(ZoneOffset.UTC);
    }

    public void setEmail(String newEmail) {
        String normalized = EmailNormalizer.normalize(newEmail);
        email = newEmail.trim();
        emailNormalized = normalized;
    }

    public void renameDisplayName(String newName) {
        if (newName == null || newName.isBlank()) {
            throw new IllegalArgumentException("displayName must not be blank");
        }
        displayName = newName.trim();
    }

    public void assignPrimaryOrgUnit(UUID orgUnitId) {
        primaryOrgUnitId = orgUnitId;
    }

    public void completeInitialSetup(String verifier, OffsetDateTime changedAt) {
        if (accountStatus != AccountStatus.PENDING_SETUP || verifier == null
                || !verifier.startsWith("$argon2id$")) {
            throw new IllegalStateException("Initial setup requires pending account and Argon2id verifier");
        }
        passwordHash = verifier;
        credentialChangedAt = Objects.requireNonNull(changedAt);
        accountStatus = AccountStatus.ACTIVE;
        deactivatedAt = null;
    }

    /** Recovery reset keeps the account ACTIVE and invalidates old credentials externally. */
    public void resetPasswordVerifier(String verifier, OffsetDateTime changedAt) {
        if (accountStatus != AccountStatus.ACTIVE || verifier == null || !verifier.startsWith("$argon2id$")) {
            throw new IllegalStateException("Only active Argon2id account credentials can be reset");
        }
        passwordHash = verifier;
        credentialChangedAt = Objects.requireNonNull(changedAt, "changedAt");
    }

    /** Updated only after a verified successful login in the authentication service. */
    public void recordSuccessfulLogin(OffsetDateTime at) {
        this.lastLoginAt = Objects.requireNonNull(at, "at");
    }

    public void assignGlobalRole(GlobalRole newRole) {
        globalRole = Objects.requireNonNull(newRole, "globalRole");
    }

    /** Mark management-scope replacement as a user-state change for HTTP ETag concurrency. */
    public void markManagementScopeChanged() {
        updatedAt = OffsetDateTime.now(ZoneOffset.UTC);
    }

    public UUID getId() { return id; }
    public String getEmail() { return email; }
    public String getEmailNormalized() { return emailNormalized; }
    public String getDisplayName() { return displayName; }
    public String getPasswordHash() { return passwordHash; }
    public GlobalRole getGlobalRole() { return globalRole; }
    public AccountStatus getAccountStatus() { return accountStatus; }
    public UUID getPrimaryOrgUnitId() { return primaryOrgUnitId; }
    public OffsetDateTime getCredentialChangedAt() { return credentialChangedAt; }
    public OffsetDateTime getLastLoginAt() { return lastLoginAt; }
    public OffsetDateTime getDeactivatedAt() { return deactivatedAt; }
    public long getVersion() { return version; }
    public OffsetDateTime getCreatedAt() { return createdAt; }
    public OffsetDateTime getUpdatedAt() { return updatedAt; }
}
