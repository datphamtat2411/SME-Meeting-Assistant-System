package com.sme.meetingassistant.api.roomscheduling.repository;
import com.sme.meetingassistant.api.roomscheduling.entity.RoomEntity;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
public interface RoomRepository extends JpaRepository<RoomEntity,UUID>{
    List<RoomEntity> findByOrganizationIdAndStatusOrderByName(UUID organizationId,com.sme.meetingassistant.api.roomscheduling.entity.RoomStatus status);
    Optional<RoomEntity> findByIdAndOrganizationId(UUID id,UUID organizationId);
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select r from RoomEntity r where r.id=:id and r.organizationId=:orgId")
    Optional<RoomEntity> findForUpdate(@Param("id") UUID id,@Param("orgId") UUID orgId);
}
