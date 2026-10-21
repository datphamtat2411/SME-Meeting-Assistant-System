package com.sme.meetingassistant.api.roomscheduling.service;

import com.sme.meetingassistant.api.roomscheduling.dto.RoomDtos;
import com.sme.meetingassistant.api.roomscheduling.entity.*;
import com.sme.meetingassistant.api.roomscheduling.repository.*;
import com.sme.meetingassistant.api.userorganization.entity.OrganizationRole;
import com.sme.meetingassistant.api.userorganization.service.OrganizationAccess;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service @Transactional
public class RoomSchedulingService {
    private final RoomRepository rooms; private final RoomReservationRepository reservations;
    private final OrganizationAccess organizations; private final ObjectProvider<MeetingReservationAccess> meetingAccess;
    public RoomSchedulingService(RoomRepository rooms,RoomReservationRepository reservations,OrganizationAccess organizations,
            ObjectProvider<MeetingReservationAccess> meetingAccess){this.rooms=rooms;this.reservations=reservations;this.organizations=organizations;this.meetingAccess=meetingAccess;}

    public RoomDtos.Room createRoom(UUID orgId,UUID callerId,RoomDtos.CreateRoom request){organizations.requireManager(orgId,callerId);
        return room(rooms.saveAndFlush(new RoomEntity(orgId,request.name().trim(),trimToNull(request.location()),request.capacity())));}
    @Transactional(readOnly=true) public List<RoomDtos.Room> listRooms(UUID orgId,UUID callerId){organizations.requireMember(orgId,callerId);
        return rooms.findByOrganizationIdAndStatusOrderByName(orgId,RoomStatus.ACTIVE).stream().map(RoomSchedulingService::room).toList();}
    public RoomDtos.Room updateRoom(UUID orgId,UUID roomId,UUID callerId,RoomDtos.UpdateRoom request){organizations.requireManager(orgId,callerId);
        RoomEntity room=rooms.findForUpdate(roomId,orgId).orElseThrow(()->new ResponseStatusException(HttpStatus.NOT_FOUND));
        if(room.getStatus()!=RoomStatus.ACTIVE)throw new ResponseStatusException(HttpStatus.CONFLICT);
        room.update(request.name().trim(),trimToNull(request.location()),request.capacity());return room(room);}
    public void disableRoom(UUID orgId,UUID roomId,UUID callerId){organizations.requireManager(orgId,callerId);
        RoomEntity room=rooms.findForUpdate(roomId,orgId).orElseThrow(()->new ResponseStatusException(HttpStatus.NOT_FOUND));
        if(reservations.existsByRoomIdAndStatusAndEndTimeAfter(roomId,ReservationStatus.CONFIRMED,OffsetDateTime.now(ZoneOffset.UTC)))
            throw new ResponseStatusException(HttpStatus.CONFLICT);
        room.disable();}

    public RoomDtos.Reservation reserve(UUID orgId,UUID roomId,UUID callerId,RoomDtos.Reserve request){
        organizations.requireMember(orgId,callerId);
        if(!request.startTime().isAfter(OffsetDateTime.now(ZoneOffset.UTC))||!request.startTime().isBefore(request.endTime()))
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
        RoomEntity room=rooms.findForUpdate(roomId,orgId).orElseThrow(()->new ResponseStatusException(HttpStatus.NOT_FOUND));
        if(room.getStatus()!=RoomStatus.ACTIVE)throw new ResponseStatusException(HttpStatus.CONFLICT);
        if(request.meetingId()!=null){MeetingReservationAccess port=meetingAccess.getIfAvailable();
            if(port==null)throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE);
            port.requireReservable(request.meetingId(),orgId,callerId,request.startTime(),request.endTime());}
        if(reservations.existsByRoomIdAndStatusAndStartTimeLessThanAndEndTimeGreaterThan(roomId,ReservationStatus.CONFIRMED,request.endTime(),request.startTime()))
            throw new ResponseStatusException(HttpStatus.CONFLICT);
        try {
            return reservation(reservations.saveAndFlush(new RoomReservationEntity(roomId,callerId,request.meetingId(),request.title().trim(),request.startTime(),request.endTime())));
        } catch (DataIntegrityViolationException reservationRace) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,null,reservationRace);
        }
    }
    @Transactional(readOnly=true) public List<RoomDtos.Reservation> listReservations(UUID orgId,UUID roomId,UUID callerId){
        organizations.requireMember(orgId,callerId);rooms.findByIdAndOrganizationId(roomId,orgId).orElseThrow(()->new ResponseStatusException(HttpStatus.NOT_FOUND));
        return reservations.findByRoomIdAndStatusAndStartTimeGreaterThanEqualOrderByStartTime(roomId,ReservationStatus.CONFIRMED,OffsetDateTime.now(ZoneOffset.UTC)).stream().map(RoomSchedulingService::reservation).toList();
    }
    public void cancelReservation(UUID orgId,UUID reservationId,UUID callerId){
        organizations.requireMember(orgId,callerId);RoomReservationEntity reservation=reservations.findById(reservationId).orElseThrow(()->new ResponseStatusException(HttpStatus.NOT_FOUND));
        RoomEntity room=rooms.findByIdAndOrganizationId(reservation.getRoomId(),orgId).orElseThrow(()->new ResponseStatusException(HttpStatus.NOT_FOUND));
        boolean manager=organizations.requireRole(orgId,callerId,OrganizationRole.OWNER,OrganizationRole.ADMIN,OrganizationRole.MEMBER).getRole()!=OrganizationRole.MEMBER;
        if(!manager&&!reservation.getRequestedBy().equals(callerId))throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        if(reservation.getStatus()!=ReservationStatus.CONFIRMED)throw new ResponseStatusException(HttpStatus.CONFLICT);
        reservation.cancel();
    }
    private static RoomDtos.Room room(RoomEntity r){return new RoomDtos.Room(r.getId(),r.getOrganizationId(),r.getName(),r.getLocation(),r.getCapacity(),r.getStatus(),r.getVersion());}
    private static RoomDtos.Reservation reservation(RoomReservationEntity r){return new RoomDtos.Reservation(r.getId(),r.getRoomId(),r.getMeetingId(),r.getRequestedBy(),r.getTitle(),r.getStartTime(),r.getEndTime(),r.getStatus(),r.getVersion());}
    private static String trimToNull(String value){return value==null||value.isBlank()?null:value.trim();}
}
