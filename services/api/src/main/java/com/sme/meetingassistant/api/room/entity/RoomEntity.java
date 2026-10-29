package com.sme.meetingassistant.api.room.entity;

import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

/** Canonical physical-room resource. Reservation history is not owned here. */
@Entity
@Table(name = "rooms")
public class RoomEntity {
    @Id
    private UUID id;

    @Column(name = "code", nullable = false, length = 64, updatable = false)
    private String code;

    @Column(name = "name", nullable = false, length = 160)
    private String name;

    @Column(name = "location", length = 255)
    private String location;

    @Column(name = "capacity")
    private Integer capacity;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 24)
    private RoomStatus status = RoomStatus.ACTIVE;

    @Column(name = "notes", columnDefinition = "TEXT")
    private String notes;

    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;

    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt;

    @Version
    @Column(name = "version", nullable = false)
    private long version;

    protected RoomEntity() { }

    public RoomEntity(String code, String name, String location, Integer capacity, String notes) {
        id = UUID.randomUUID();
        this.code = code;
        this.name = name;
        this.location = location;
        this.capacity = capacity;
        this.notes = notes;
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

    public void updateMetadata(String name, String location, Integer capacity, String notes) {
        this.name = name;
        this.location = location;
        this.capacity = capacity;
        this.notes = notes;
    }

    public void deactivate() {
        status = RoomStatus.INACTIVE;
    }

    public UUID getId() { return id; }
    public String getCode() { return code; }
    public String getName() { return name; }
    public String getLocation() { return location; }
    public Integer getCapacity() { return capacity; }
    public RoomStatus getStatus() { return status; }
    public String getNotes() { return notes; }
    public OffsetDateTime getCreatedAt() { return createdAt; }
    public OffsetDateTime getUpdatedAt() { return updatedAt; }
    public long getVersion() { return version; }
}
