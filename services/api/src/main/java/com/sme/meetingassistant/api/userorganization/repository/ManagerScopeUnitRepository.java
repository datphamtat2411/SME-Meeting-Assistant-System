package com.sme.meetingassistant.api.userorganization.repository;

import com.sme.meetingassistant.api.userorganization.entity.ManagerScopeId;
import com.sme.meetingassistant.api.userorganization.entity.ManagerScopeUnitEntity;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ManagerScopeUnitRepository extends JpaRepository<ManagerScopeUnitEntity, ManagerScopeId> {
    List<ManagerScopeUnitEntity> findByIdUserId(UUID userId);
    boolean existsByIdUserIdAndIdOrgUnitId(UUID userId, UUID orgUnitId);
}
