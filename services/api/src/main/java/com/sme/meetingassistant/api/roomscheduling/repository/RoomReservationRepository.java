package com.sme.meetingassistant.api.roomscheduling.repository;
import com.sme.meetingassistant.api.roomscheduling.entity.RoomReservationEntity;
import com.sme.meetingassistant.api.roomscheduling.entity.ReservationStatus;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
public interface RoomReservationRepository extends JpaRepository<RoomReservationEntity,UUID>{
    boolean existsByRoomIdAndStatusAndStartTimeLessThanAndEndTimeGreaterThan(UUID roomId,ReservationStatus status,OffsetDateTime end,OffsetDateTime start);
    boolean existsByRoomIdAndStatusAndEndTimeAfter(UUID roomId,ReservationStatus status,OffsetDateTime after);
    List<RoomReservationEntity> findByRoomIdAndStatusAndStartTimeGreaterThanEqualOrderByStartTime(UUID roomId,ReservationStatus status,OffsetDateTime from);
}
