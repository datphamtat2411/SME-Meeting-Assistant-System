package com.sme.meetingassistant.api.userorganization.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;
import java.io.Serializable;
import java.util.Objects;
import java.util.UUID;

@Embeddable
public class ManagerScopeId implements Serializable {
    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "org_unit_id", nullable = false)
    private UUID orgUnitId;

    protected ManagerScopeId() { }

    public ManagerScopeId(UUID userId, UUID orgUnitId) {
        this.userId = Objects.requireNonNull(userId, "userId");
        this.orgUnitId = Objects.requireNonNull(orgUnitId, "orgUnitId");
    }

    public UUID getUserId() { return userId; }
    public UUID getOrgUnitId() { return orgUnitId; }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof ManagerScopeId that)) return false;
        return Objects.equals(userId, that.userId) && Objects.equals(orgUnitId, that.orgUnitId);
    }

    @Override
    public int hashCode() { return Objects.hash(userId, orgUnitId); }
}
