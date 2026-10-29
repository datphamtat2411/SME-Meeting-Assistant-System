package com.sme.meetingassistant.api.room.reservation;

import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import com.sme.meetingassistant.api.meeting.service.MeetingReservationStateLookup;
import com.sme.meetingassistant.api.room.service.RoomCatalogService;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.Optional;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Authoritative internal reservation boundary, never exposed as an independent
 * booking API. T04 provides organizer permission, Meeting state transitions,
 * If-Match checks and notification emission in the SAME outer transaction.
 */
@Service
public class RoomReservationService {
    private final MeetingReservationStateLookup meetings;
    private final RoomCatalogService rooms;
    private final RoomReservationStore reservations;
    public RoomReservationService(MeetingReservationStateLookup meetings,
            RoomCatalogService rooms, RoomReservationStore reservations) {
        this.meetings=meetings; this.rooms=rooms; this.reservations=reservations;
    }

    /**
     * Synchronizes a *committed* meeting to its single active reservation.
     * Requires the caller's outer transaction. The Meeting JPA state must be
     * flushed before invocation. Previous rows survive as RELEASED history.
     * Idempotent when room and absolute half-open interval are unchanged.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public Optional<RoomReservation> synchronizeCommitted(UUID meetingId) {
        var meeting=meetings.lockCurrent(meetingId);
        if (meeting.status()!=MeetingStatus.SCHEDULED
                && meeting.status()!=MeetingStatus.IN_PROGRESS) throw conflict();
        OffsetDateTime start=meeting.start(), end=meeting.end();
        if(start==null || end==null || !start.toInstant().isBefore(end.toInstant())) throw conflict();
        UUID roomId=meeting.roomId();
        // Lock ROOM rows in stable order BEFORE locking reservation rows.
        // Otherwise concurrent A -> B and B -> A reschedules can deadlock:
        // A holds reservation A and waits on B, B holds reservation B and
        // waits on A. The canonical Meeting row is already locked.
        UUID priorRoomId=reservations.activeRoomId(meetingId).orElse(null);
        if (roomId != null || priorRoomId != null) {
            rooms.requireReservableWithPrior(roomId, priorRoomId);
        }
        RoomReservation active=reservations.lockActive(meetingId).orElse(null);
        if (active!=null && priorRoomId!=null && !active.roomId().equals(priorRoomId)) {
            throw conflict(); // external writer changed the row during lock admission
        }
        if (active!=null && roomId!=null && active.roomId().equals(roomId)
                && active.start().toInstant().equals(start.toInstant())
                && active.end().toInstant().equals(end.toInstant())) {
            return Optional.of(active);
        }
        if (active!=null) reservations.release(active);
        if (roomId==null) return Optional.empty();
        try {
            return Optional.of(reservations.insert(meetingId,roomId,start,end));
        } catch (DataIntegrityViolationException error) {
            if(isExpectedReservationConflict(error)) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Room is already reserved for the requested period",error);
            }
            throw error;
        }
    }

    /**
     * Release on cancellation; requires the Meeting to have already transitioned
     * to CANCELLED in the same transaction. Repeated release is harmless.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void releaseCancelled(UUID meetingId) {
        var meeting=meetings.lockCurrent(meetingId);
        if(meeting.status()!=MeetingStatus.CANCELLED) throw conflict();
        reservations.lockActive(meetingId).ifPresent(reservations::release);
    }

    /**
     * A completed occurrence no longer blocks future room reuse, even if its
     * originally planned interval has not elapsed. History remains RELEASED.
     * Must be called AFTER the Meeting has been flushed to ENDED.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void releaseEnded(UUID meetingId) {
        var meeting = meetings.lockCurrent(meetingId);
        if (meeting.status() != MeetingStatus.ENDED) throw conflict();
        reservations.lockActive(meetingId).ifPresent(reservations::release);
    }

    private static boolean isExpectedReservationConflict(Throwable error) {
        for(Throwable cause=error;cause!=null;cause=cause.getCause()) {
            if(cause instanceof SQLException sql && ("23P01".equals(sql.getSQLState())
                    || "23505".equals(sql.getSQLState()))) return true;
        }
        return false;
    }
    private static ResponseStatusException conflict() {
        return new ResponseStatusException(HttpStatus.CONFLICT);
    }
}
