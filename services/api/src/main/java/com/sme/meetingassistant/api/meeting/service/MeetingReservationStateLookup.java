package com.sme.meetingassistant.api.meeting.service;

import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import java.time.OffsetDateTime;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/** Cross-module read boundary: the reservation module never owns or edits Meeting rows. */
@Service
public class MeetingReservationStateLookup {
    private final JdbcTemplate jdbc;
    public MeetingReservationStateLookup(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    /**
     * The caller holds an outer business transaction. SELECT FOR UPDATE prevents
     * a competing Meeting transition from changing the schedule while reserving.
     * T04 must flush its JPA Meeting state before calling this method.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public Snapshot lockCurrent(UUID meetingId) {
        return jdbc.query("""
            SELECT id, room_id, scheduled_start_at, scheduled_end_at, status
            FROM meetings WHERE id=? FOR UPDATE
            """, (rs, rowNum) -> new Snapshot(
                rs.getObject("id",UUID.class),
                rs.getObject("room_id",UUID.class),
                rs.getObject("scheduled_start_at",OffsetDateTime.class),
                rs.getObject("scheduled_end_at",OffsetDateTime.class),
                MeetingStatus.valueOf(rs.getString("status"))), meetingId).stream()
            .findFirst().orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
    }

    public record Snapshot(UUID meetingId, UUID roomId, OffsetDateTime start,
                           OffsetDateTime end, MeetingStatus status) { }
}
