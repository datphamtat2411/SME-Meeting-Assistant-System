package com.sme.meetingassistant.api.room.reservation;

import java.time.OffsetDateTime;
import java.util.UUID;

/** A read-only reservation projection. Range representation belongs to PostgreSQL. */
public record RoomReservation(
    UUID id, UUID meetingId, UUID roomId, OffsetDateTime start, OffsetDateTime end,
    Status status, OffsetDateTime createdAt, OffsetDateTime releasedAt, long version
) {
    public enum Status { ACTIVE, RELEASED }
}
