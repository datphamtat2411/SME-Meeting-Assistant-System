package com.sme.meetingassistant.api.userorganization.entity;

import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

@Entity @Table(name="organization_memberships", uniqueConstraints=@UniqueConstraint(name="ux_org_membership_user", columnNames={"organization_id","user_id"}))
public class OrganizationMembershipEntity {
    @Id private UUID id;
    @Column(name="organization_id", nullable=false) private UUID organizationId;
    @Column(name="user_id", nullable=false) private UUID userId;
    @Enumerated(EnumType.STRING) @Column(nullable=false, length=20) private OrganizationRole role;
    @Column(nullable=false, length=20) private String status="ACTIVE";
    @Column(name="created_at", nullable=false, updatable=false) private OffsetDateTime createdAt;
    @Column(name="updated_at", nullable=false) private OffsetDateTime updatedAt;
    protected OrganizationMembershipEntity() { }
    public OrganizationMembershipEntity(UUID orgId, UUID userId, OrganizationRole role){this.id=UUID.randomUUID();this.organizationId=orgId;this.userId=userId;this.role=role;}
    @PrePersist void onCreate(){var now=OffsetDateTime.now(ZoneOffset.UTC);createdAt=now;updatedAt=now;}
    @PreUpdate void onUpdate(){updatedAt=OffsetDateTime.now(ZoneOffset.UTC);}
    public UUID getId(){return id;} public UUID getOrganizationId(){return organizationId;} public UUID getUserId(){return userId;}
    public OrganizationRole getRole(){return role;} public String getStatus(){return status;}
    public OffsetDateTime getCreatedAt(){return createdAt;} public OffsetDateTime getUpdatedAt(){return updatedAt;}
    public void changeRole(OrganizationRole role){this.role=role;this.status="ACTIVE";}
    public void remove(){this.status="REMOVED";}
}
