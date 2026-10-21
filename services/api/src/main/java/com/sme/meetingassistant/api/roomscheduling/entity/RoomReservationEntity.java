package com.sme.meetingassistant.api.roomscheduling.entity;
import jakarta.persistence.*;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
@Entity @Table(name="room_reservations")
public class RoomReservationEntity {
    @Id private UUID id;
    @Column(name="room_id",nullable=false) private UUID roomId;
    @Column(name="requested_by",nullable=false) private UUID requestedBy;
    @Column(name="meeting_id") private UUID meetingId;
    @Column(nullable=false,length=255) private String title;
    @Column(name="start_time",nullable=false) private OffsetDateTime startTime;
    @Column(name="end_time",nullable=false) private OffsetDateTime endTime;
    @Enumerated(EnumType.STRING) @Column(nullable=false,length=20) private ReservationStatus status=ReservationStatus.CONFIRMED;
    @Version @Column(nullable=false) private long version;
    @Column(name="created_at",nullable=false,updatable=false) private OffsetDateTime createdAt;
    @Column(name="updated_at",nullable=false) private OffsetDateTime updatedAt;
    protected RoomReservationEntity(){}
    public RoomReservationEntity(UUID roomId,UUID requestedBy,UUID meetingId,String title,OffsetDateTime start,OffsetDateTime end){id=UUID.randomUUID();this.roomId=roomId;this.requestedBy=requestedBy;this.meetingId=meetingId;this.title=title;startTime=start;endTime=end;}
    @PrePersist void onCreate(){var now=OffsetDateTime.now(ZoneOffset.UTC);createdAt=now;updatedAt=now;}
    @PreUpdate void onUpdate(){updatedAt=OffsetDateTime.now(ZoneOffset.UTC);}
    public UUID getId(){return id;} public UUID getRoomId(){return roomId;} public UUID getRequestedBy(){return requestedBy;} public UUID getMeetingId(){return meetingId;} public String getTitle(){return title;} public OffsetDateTime getStartTime(){return startTime;} public OffsetDateTime getEndTime(){return endTime;} public ReservationStatus getStatus(){return status;} public long getVersion(){return version;}
    public void cancel(){status=ReservationStatus.CANCELLED;}
}
