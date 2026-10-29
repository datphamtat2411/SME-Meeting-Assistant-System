package com.sme.meetingassistant.api.room.dto;

import com.sme.meetingassistant.api.room.entity.RoomStatus;
import java.time.OffsetDateTime;
import java.util.UUID;

public record RoomView(
    UUID id,
    String code,
    String name,
    String location,
    Integer capacity,
    RoomStatus status,
    String notes,
    OffsetDateTime createdAt,
    OffsetDateTime updatedAt
) { }
