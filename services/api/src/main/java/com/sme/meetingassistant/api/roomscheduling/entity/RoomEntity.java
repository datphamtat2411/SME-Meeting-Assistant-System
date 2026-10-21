package com.sme.meetingassistant.api.roomscheduling.entity;
import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
@Entity @Table(name="rooms")
public class RoomEntity {
    @Id private UUID id;
    @Column(name="organization_id",nullable=false) private UUID organizationId;
    @Column(nullable=false,length=120) private String name;
    @Column(length=255) private String location;
    @Column(nullable=false) private int capacity;
    @Enumerated(EnumType.STRING) @Column(nullable=false,length=20) private RoomStatus status=RoomStatus.ACTIVE;
    @Version @Column(nullable=false) private long version;
    @Column(name="created_at",nullable=false,updatable=false) private OffsetDateTime createdAt;
    @Column(name="updated_at",nullable=false) private OffsetDateTime updatedAt;
    protected RoomEntity(){}
    public RoomEntity(UUID orgId,String name,String location,int capacity){id=UUID.randomUUID();organizationId=orgId;this.name=name;this.location=location;this.capacity=capacity;}
    @PrePersist void onCreate(){var now=OffsetDateTime.now(ZoneOffset.UTC);createdAt=now;updatedAt=now;}
    @PreUpdate void onUpdate(){updatedAt=OffsetDateTime.now(ZoneOffset.UTC);}
    public UUID getId(){return id;} public UUID getOrganizationId(){return organizationId;} public String getName(){return name;} public String getLocation(){return location;} public int getCapacity(){return capacity;} public RoomStatus getStatus(){return status;} public long getVersion(){return version;}
    public void update(String name,String location,int capacity){this.name=name;this.location=location;this.capacity=capacity;}
    public void disable(){status=RoomStatus.DISABLED;}
}
