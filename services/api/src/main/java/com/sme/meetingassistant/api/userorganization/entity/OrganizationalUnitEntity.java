package com.sme.meetingassistant.api.userorganization.entity;

import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Objects;
import java.util.UUID;

/** Internal department/team; this is not a tenant or a standalone SaaS organization. */
@Entity
@Table(name = "organizational_units")
public class OrganizationalUnitEntity {
    @Id
    private UUID id;

    @Column(name = "code", nullable = false, length = 64)
    private String code;

    @Column(name = "name", nullable = false, length = 160)
    private String name;

    @Column(name = "parent_id")
    private UUID parentId;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 32)
    private OrganizationalUnitStatus status = OrganizationalUnitStatus.ACTIVE;

    @Version
    @Column(name = "version", nullable = false)
    private long version;

    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;

    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt;

    protected OrganizationalUnitEntity() { }

    public OrganizationalUnitEntity(String code, String name, UUID parentId) {
        this.id = UUID.randomUUID();
        this.code = requiredText(code, "code");
        this.name = requiredText(name, "name");
        setParentId(parentId);
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

    public void setParentId(UUID parentId) {
        if (Objects.equals(id, parentId)) {
            throw new IllegalArgumentException("An organizational unit cannot parent itself");
        }
        this.parentId = parentId;
    }

    public void rename(String newName) { name = requiredText(newName, "name"); }

    public void deactivate() { status = OrganizationalUnitStatus.INACTIVE; }

    private static String requiredText(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(field + " must not be blank");
        }
        return value.trim();
    }

    public UUID getId() { return id; }
    public String getCode() { return code; }
    public String getName() { return name; }
    public UUID getParentId() { return parentId; }
    public OrganizationalUnitStatus getStatus() { return status; }
    public long getVersion() { return version; }
    public OffsetDateTime getCreatedAt() { return createdAt; }
    public OffsetDateTime getUpdatedAt() { return updatedAt; }
}
