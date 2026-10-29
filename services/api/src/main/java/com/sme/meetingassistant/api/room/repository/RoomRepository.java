package com.sme.meetingassistant.api.room.repository;

import com.sme.meetingassistant.api.room.entity.RoomEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import java.util.UUID;

public interface RoomRepository extends JpaRepository<RoomEntity, UUID>, JpaSpecificationExecutor<RoomEntity> {
    boolean existsByCode(String code);
}
