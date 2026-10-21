package com.sme.meetingassistant.api.roomscheduling.dto;
import com.sme.meetingassistant.api.roomscheduling.entity.ReservationStatus;
import com.sme.meetingassistant.api.roomscheduling.entity.RoomStatus;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.OffsetDateTime;
import java.util.UUID;
public final class RoomDtos {
    private RoomDtos(){}
    public record CreateRoom(@NotBlank @Size(max=120) String name,@Size(max=255) String location,@Min(1) int capacity){}
    public record UpdateRoom(@NotBlank @Size(max=120) String name,@Size(max=255) String location,@Min(1) int capacity){}
    public record Reserve(@NotBlank @Size(max=255) String title,@NotNull OffsetDateTime startTime,@NotNull OffsetDateTime endTime,UUID meetingId){}
    public record Room(UUID id,UUID organizationId,String name,String location,int capacity,RoomStatus status,long version){}
    public record Reservation(UUID id,UUID roomId,UUID meetingId,UUID requestedBy,String title,OffsetDateTime startTime,OffsetDateTime endTime,ReservationStatus status,long version){}
}
