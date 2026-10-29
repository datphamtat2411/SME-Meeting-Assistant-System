package com.sme.meetingassistant.api.room.repository;

import com.sme.meetingassistant.api.room.entity.RoomEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import java.util.UUID;
import java.util.Optional;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface RoomRepository extends JpaRepository<RoomEntity, UUID>, JpaSpecificationExecutor<RoomEntity> {
    boolean existsByCode(String code);

    /** Serializes reservation admission with room deactivation/update transactions. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select r from RoomEntity r where r.id=:roomId")
    Optional<RoomEntity> findForReservation(@Param("roomId") UUID roomId);
}
