package com.sme.meetingassistant.api.meeting.entity;

import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

@Entity
@Table(name = "meeting_participants")
public class MeetingParticipantEntity {
    @Id private UUID id;
    @Column(name = "meeting_id", nullable = false, updatable = false) private UUID meetingId;
    @Column(name = "user_id", nullable = false, updatable = false) private UUID userId;
    @Column(name = "added_by_user_id", updatable = false) private UUID addedByUserId;
    @Column(name = "added_at", nullable = false, updatable = false) private OffsetDateTime addedAt;
    @Column(name = "removed_at") private OffsetDateTime removedAt;
    @Column(name = "removed_by_user_id") private UUID removedByUserId;

    protected MeetingParticipantEntity() {}
    public MeetingParticipantEntity(UUID meetingId, UUID userId, UUID actorId) {
        id = UUID.randomUUID(); this.meetingId = meetingId;
        this.userId = userId; addedByUserId = actorId;
    }
    @PrePersist void onCreate() { addedAt = OffsetDateTime.now(ZoneOffset.UTC); }
    public void remove(UUID actorId) {
        removedAt = OffsetDateTime.now(ZoneOffset.UTC); removedByUserId = actorId;
    }
    public UUID getId() { return id; }
    public UUID getMeetingId() { return meetingId; }
    public UUID getUserId() { return userId; }
    public UUID getAddedByUserId() { return addedByUserId; }
    public OffsetDateTime getAddedAt() { return addedAt; }
    public OffsetDateTime getRemovedAt() { return removedAt; }
    public UUID getRemovedByUserId() { return removedByUserId; }
}
