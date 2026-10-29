package com.sme.meetingassistant.api.userorganization.repository;

import com.sme.meetingassistant.api.userorganization.entity.ManagerScopeId;
import com.sme.meetingassistant.api.userorganization.entity.ManagerScopeUnitEntity;
import com.sme.meetingassistant.api.userorganization.entity.OrganizationalUnitStatus;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ManagerScopeUnitRepository extends JpaRepository<ManagerScopeUnitEntity, ManagerScopeId> {
    List<ManagerScopeUnitEntity> findByIdUserId(UUID userId);
    boolean existsByIdUserIdAndIdOrgUnitId(UUID userId, UUID orgUnitId);

    /**
     * Only currently ACTIVE organization units confer management authority.
     * Keep the underlying manager_scope_units rows for historical attribution.
     */
    @Query("""
        SELECT scopeGrant.id.orgUnitId FROM ManagerScopeUnitEntity scopeGrant, OrganizationalUnitEntity unit
        WHERE scopeGrant.id.userId = :userId AND unit.id = scopeGrant.id.orgUnitId
          AND unit.status = :status
        """)
    List<UUID> findGrantedUnitIdsByUserIdAndStatus(@Param("userId") UUID userId,
            @Param("status") OrganizationalUnitStatus status);
}
