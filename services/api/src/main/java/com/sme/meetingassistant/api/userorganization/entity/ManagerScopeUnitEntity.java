package com.sme.meetingassistant.api.userorganization.entity;

import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

/** Explicit managerial scope; never an implicit grant of meeting-content access. */
@Entity
@Table(name = "manager_scope_units")
public class ManagerScopeUnitEntity {
    @EmbeddedId
    private ManagerScopeId id;

    @Column(name = "granted_by_user_id")
    private UUID grantedByUserId;

    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;

    protected ManagerScopeUnitEntity() { }

    public ManagerScopeUnitEntity(UUID managerUserId, UUID orgUnitId, UUID grantedByUserId) {
        this.id = new ManagerScopeId(managerUserId, orgUnitId);
        this.grantedByUserId = grantedByUserId;
    }

    @PrePersist
    void onCreate() {
        createdAt = OffsetDateTime.now(ZoneOffset.UTC);
    }

    public ManagerScopeId getId() { return id; }
    public UUID getGrantedByUserId() { return grantedByUserId; }
    public OffsetDateTime getCreatedAt() { return createdAt; }
}
