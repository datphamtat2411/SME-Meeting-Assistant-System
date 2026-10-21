package com.sme.meetingassistant.api.userorganization.entity;

import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

@Entity @Table(name = "organizations")
public class OrganizationEntity {
    @Id private UUID id;
    @Column(nullable = false, length = 160) private String name;
    @Column(nullable = false, unique = true, length = 180) private String slug;
    @Enumerated(EnumType.STRING) @Column(nullable = false, length = 20) private OrganizationStatus status = OrganizationStatus.ACTIVE;
    @Version @Column(nullable = false) private long version;
    @Column(name="created_at", nullable=false, updatable=false) private OffsetDateTime createdAt;
    @Column(name="updated_at", nullable=false) private OffsetDateTime updatedAt;
    protected OrganizationEntity() { }
    public OrganizationEntity(String name, String slug) { this.id=UUID.randomUUID(); this.name=name; this.slug=slug; }
    @PrePersist void onCreate() { var now=OffsetDateTime.now(ZoneOffset.UTC); createdAt=now; updatedAt=now; }
    @PreUpdate void onUpdate() { updatedAt=OffsetDateTime.now(ZoneOffset.UTC); }
    public UUID getId(){return id;} public String getName(){return name;} public String getSlug(){return slug;}
    public OrganizationStatus getStatus(){return status;} public long getVersion(){return version;}
    public OffsetDateTime getCreatedAt(){return createdAt;}
    public void rename(String name){this.name=name;}
}
