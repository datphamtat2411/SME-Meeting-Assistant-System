package com.sme.meetingassistant.api.room.availability;

import com.sme.meetingassistant.api.room.entity.RoomEntity;
import com.sme.meetingassistant.api.room.entity.RoomStatus;
import com.sme.meetingassistant.api.room.repository.RoomRepository;
import com.sme.meetingassistant.api.userorganization.service.OrganizationalAuthorizationService;
import java.sql.Types;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Advisory snapshot of ACTIVE committed room reservations. PostgreSQL's GiST
 * exclusion constraint and T04 command transaction remain the write authority.
 * Never exposes meeting identifiers, occupancy ownership, or private content.
 */
@Service
@Transactional(readOnly = true)
public class RoomAvailabilityService {
    private final NamedParameterJdbcTemplate jdbc;
    private final RoomRepository rooms;
    private final OrganizationalAuthorizationService authorization;

    public RoomAvailabilityService(NamedParameterJdbcTemplate jdbc, RoomRepository rooms,
            OrganizationalAuthorizationService authorization) {
        this.jdbc = jdbc; this.rooms = rooms; this.authorization = authorization;
    }

    public record AvailableRoom(UUID id, String code, String name, String location, Integer capacity,
            boolean available, Integer participantCount, Boolean capacityExceeded) { }

    public record RoomSignal(UUID roomId, boolean active, boolean available,
            Integer capacity, Integer participantCount, Boolean capacityExceeded) { }

    public static void requireInterval(OffsetDateTime start, OffsetDateTime end) {
        if (start == null || end == null || !start.toInstant().isBefore(end.toInstant())) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                "start must be earlier than end");
        }
    }

    /** No cross-module exclusion is accepted at this public catalog endpoint. */
    public Page<AvailableRoom> list(OffsetDateTime start, OffsetDateTime end,
            String q, Integer minCapacity, Integer participantCount, boolean availableOnly,
            Pageable page) {
        authorization.requireActiveActor();
        requireInterval(start, end);
        validateCount(minCapacity, true);
        validateCount(participantCount, false);
        if (q != null && q.length() > 200) throw invalid();
        if (page.getPageSize() < 1 || page.getPageSize() > 100) throw invalid();

        MapSqlParameterSource args = new MapSqlParameterSource()
            .addValue("start", start).addValue("end", end)
            .addValue("limit", page.getPageSize()).addValue("offset", page.getOffset());
        String where = " FROM rooms r WHERE r.status='ACTIVE'";
        if (q != null && !q.isBlank()) {
            String pattern = "%" + q.trim().toLowerCase(Locale.ROOT)
                .replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%";
            args.addValue("pattern",pattern);
            where += " AND (lower(r.code) LIKE :pattern ESCAPE '!'"
                + " OR lower(r.name) LIKE :pattern ESCAPE '!'"
                + " OR lower(r.location) LIKE :pattern ESCAPE '!')";
        }
        if (minCapacity != null) {
            args.addValue("minCapacity", minCapacity);
            where += " AND r.capacity >= :minCapacity";
        }
        String noConflict = noConflictSql(null);
        if (availableOnly) where += " AND " + noConflict;
        Long total = jdbc.queryForObject("SELECT count(*)" + where, args, Long.class);
        String sql = "SELECT r.id,r.code,r.name,r.location,r.capacity,(" + noConflict
            + ") AS available" + where + " ORDER BY r.code ASC,r.id ASC LIMIT :limit OFFSET :offset";
        List<AvailableRoom> rows = jdbc.query(sql, args, (rs,n) -> {
            int capacity = rs.getInt("capacity");
            Integer cap = rs.wasNull() ? null : capacity;
            return new AvailableRoom(rs.getObject("id",UUID.class),
                rs.getString("code"),rs.getString("name"),rs.getString("location"),cap,
                rs.getBoolean("available"),participantCount,capacityExceeded(cap,participantCount));
        });
        return new PageImpl<>(rows,page,total == null ? 0 : total);
    }

    /** Internal single-room preview. The caller has already passed scheduling auth. */
    public RoomSignal inspect(UUID roomId, OffsetDateTime start, OffsetDateTime end,
            UUID authorizedExcludedMeetingId, Integer participantCount) {
        authorization.requireActiveActor();
        requireInterval(start,end);
        validateCount(participantCount,false);
        RoomEntity room = rooms.findById(roomId)
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        boolean active = room.getStatus() == RoomStatus.ACTIVE;
        MapSqlParameterSource args=new MapSqlParameterSource()
            .addValue("start",start).addValue("end",end)
            .addValue("roomId",roomId);
        if (authorizedExcludedMeetingId != null) {
            args.addValue("excludeMeetingId",authorizedExcludedMeetingId);
        }
        Boolean noConflict=jdbc.queryForObject("SELECT " + noConflictSql(authorizedExcludedMeetingId)
            .replace("r.id",":roomId"),args,Boolean.class);
        return new RoomSignal(roomId,active,active && Boolean.TRUE.equals(noConflict),
            room.getCapacity(),participantCount,capacityExceeded(room.getCapacity(),participantCount));
    }

    private static String noConflictSql(UUID excluded) {
        return "NOT EXISTS (SELECT 1 FROM room_reservations rr WHERE rr.room_id=r.id"
            + " AND rr.status='ACTIVE'"
            + " AND rr.reserved_period && tstzrange(CAST(:start AS timestamptz),"
            + " CAST(:end AS timestamptz),'[)')"
            + (excluded == null ? "" : " AND rr.meeting_id<>:excludeMeetingId")
            + ")";
    }

    private static Boolean capacityExceeded(Integer capacity, Integer people) {
        return capacity == null || people == null ? null : people > capacity;
    }
    private static void validateCount(Integer number, boolean strictlyPositive) {
        if (number != null && (number < (strictlyPositive ? 1 : 0) || number > 100000)) throw invalid();
    }
    private static ResponseStatusException invalid() {
        return new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
    }
}
