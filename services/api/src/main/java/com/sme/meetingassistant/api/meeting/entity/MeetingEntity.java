package com.sme.meetingassistant.api.meeting.entity;

import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

@Entity
@Table(name = "meetings")
public class MeetingEntity {
    @Id private UUID id;
    @Column(nullable = false, length = 255) private String title;
    @Column(columnDefinition = "TEXT") private String description;
    @Column(name = "organizer_user_id", nullable = false, updatable = false) private UUID organizerUserId;
    @Column(name = "room_id") private UUID roomId;
    @Column(name = "scheduled_start_at") private OffsetDateTime scheduledStartAt;
    @Column(name = "scheduled_end_at") private OffsetDateTime scheduledEndAt;
    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 24) private MeetingStatus status = MeetingStatus.DRAFT;
    @Column(name = "started_at") private OffsetDateTime startedAt;
    @Column(name = "ended_at") private OffsetDateTime endedAt;
    @Column(name = "cancelled_at") private OffsetDateTime cancelledAt;
    @Column(name = "cancellation_reason", columnDefinition = "TEXT") private String cancellationReason;
    @Column(name = "created_by_user_id", nullable = false, updatable = false) private UUID createdByUserId;
    @Column(name = "created_at", nullable = false, updatable = false) private OffsetDateTime createdAt;
    @Column(name = "updated_at", nullable = false) private OffsetDateTime updatedAt;
    @Version @Column(nullable = false) private long version;

    protected MeetingEntity() {}

    public MeetingEntity(UUID organizerId, String title, String description) {
        id = UUID.randomUUID();
        organizerUserId = organizerId;
        createdByUserId = organizerId;
        this.title = title;
        this.description = description;
    }

    @PrePersist void onCreate() {
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        createdAt = now;
        updatedAt = now;
    }
    @PreUpdate void onUpdate() { updatedAt = OffsetDateTime.now(ZoneOffset.UTC); }

    public void editMetadata(String title, String description) {
        this.title = title; this.description = description; touch();
    }
    /** A draft can select a room provisionally, but this does not create a reservation. */
    public void editDraftSchedule(OffsetDateTime start, OffsetDateTime end, UUID room) {
        scheduledStartAt = start; scheduledEndAt = end; roomId = room; touch();
    }
    public void scheduleRoomless() {
        status = MeetingStatus.SCHEDULED; touch();
    }
    public void start(OffsetDateTime when) {
        status = MeetingStatus.IN_PROGRESS; startedAt = when; touch();
    }
    public void end(OffsetDateTime when) {
        status = MeetingStatus.ENDED; endedAt = when; touch();
    }
    public void cancel(OffsetDateTime when, String reason) {
        status = MeetingStatus.CANCELLED; cancelledAt = when; cancellationReason = reason; touch();
    }
    public void touch() { updatedAt = OffsetDateTime.now(ZoneOffset.UTC); }

    public UUID getId() { return id; }
    public String getTitle() { return title; }
    public String getDescription() { return description; }
    public UUID getOrganizerUserId() { return organizerUserId; }
    public UUID getRoomId() { return roomId; }
    public OffsetDateTime getScheduledStartAt() { return scheduledStartAt; }
    public OffsetDateTime getScheduledEndAt() { return scheduledEndAt; }
    public MeetingStatus getStatus() { return status; }
    public OffsetDateTime getStartedAt() { return startedAt; }
    public OffsetDateTime getEndedAt() { return endedAt; }
    public OffsetDateTime getCancelledAt() { return cancelledAt; }
    public String getCancellationReason() { return cancellationReason; }
    public UUID getCreatedByUserId() { return createdByUserId; }
    public OffsetDateTime getCreatedAt() { return createdAt; }
    public OffsetDateTime getUpdatedAt() { return updatedAt; }
    public long getVersion() { return version; }
}
