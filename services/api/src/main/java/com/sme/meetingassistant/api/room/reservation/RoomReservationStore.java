package com.sme.meetingassistant.api.room.reservation;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** PostgreSQL-native range storage; avoids an artificial JPA tstzrange mapping layer. */
@Repository
public class RoomReservationStore {
    private final JdbcTemplate jdbc;
    public RoomReservationStore(JdbcTemplate jdbc) { this.jdbc=jdbc; }

    /**
     * Non-locking read used ONLY to plan stable room-row lock order.
     * The active reservation is re-read with FOR UPDATE afterward.
     */
    public Optional<UUID> activeRoomId(UUID meetingId) {
        return jdbc.query("""
            SELECT room_id FROM room_reservations
            WHERE meeting_id=? AND status='ACTIVE'
            """, (rs,i)->rs.getObject("room_id",UUID.class),meetingId).stream().findFirst();
    }

    public Optional<RoomReservation> lockActive(UUID meetingId) {
        return jdbc.query("""
            SELECT id,meeting_id,room_id,lower(reserved_period) AS starts,
                   upper(reserved_period) AS ends,status,created_at,released_at,version
            FROM room_reservations
            WHERE meeting_id=? AND status='ACTIVE'
            FOR UPDATE
            """, (rs,i)->new RoomReservation(
                rs.getObject("id",UUID.class),rs.getObject("meeting_id",UUID.class),
                rs.getObject("room_id",UUID.class),
                rs.getObject("starts",OffsetDateTime.class),rs.getObject("ends",OffsetDateTime.class),
                RoomReservation.Status.valueOf(rs.getString("status")),
                rs.getObject("created_at",OffsetDateTime.class),
                rs.getObject("released_at",OffsetDateTime.class),
                rs.getLong("version")),meetingId).stream().findFirst();
    }

    public RoomReservation insert(UUID meetingId, UUID roomId, OffsetDateTime start, OffsetDateTime end) {
        UUID id=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO room_reservations(id,meeting_id,room_id,reserved_period)
            VALUES (?,?,?,tstzrange(?::timestamptz,?::timestamptz,'[)'))
            """,id,meetingId,roomId,start,end);
        return lockActive(meetingId).orElseThrow();
    }

    public void release(RoomReservation reservation) {
        int updated=jdbc.update("""
            UPDATE room_reservations
            SET status='RELEASED', released_at=clock_timestamp(), version=version+1
            WHERE id=? AND status='ACTIVE' AND version=?
            """,reservation.id(),reservation.version());
        if(updated!=1) throw new IllegalStateException("Reservation version changed under meeting transaction");
    }

    public List<RoomReservation> history(UUID meetingId) {
        return jdbc.query("""
            SELECT id,meeting_id,room_id,lower(reserved_period) AS starts,
                   upper(reserved_period) AS ends,status,created_at,released_at,version
            FROM room_reservations WHERE meeting_id=?
            ORDER BY created_at,id
            """, (rs,i)->new RoomReservation(
                rs.getObject("id",UUID.class),rs.getObject("meeting_id",UUID.class),
                rs.getObject("room_id",UUID.class),
                rs.getObject("starts",OffsetDateTime.class),rs.getObject("ends",OffsetDateTime.class),
                RoomReservation.Status.valueOf(rs.getString("status")),
                rs.getObject("created_at",OffsetDateTime.class),
                rs.getObject("released_at",OffsetDateTime.class),rs.getLong("version")),meetingId);
    }
}
