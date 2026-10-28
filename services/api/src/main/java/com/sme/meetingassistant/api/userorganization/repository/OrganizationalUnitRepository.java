package com.sme.meetingassistant.api.userorganization.repository;

import com.sme.meetingassistant.api.userorganization.entity.OrganizationalUnitEntity;
import com.sme.meetingassistant.api.userorganization.entity.OrganizationalUnitStatus;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface OrganizationalUnitRepository extends JpaRepository<OrganizationalUnitEntity, UUID> {
    Optional<OrganizationalUnitEntity> findByCode(String code);
    List<OrganizationalUnitEntity> findByStatusOrderByNameAsc(OrganizationalUnitStatus status);
    List<OrganizationalUnitEntity> findByParentId(UUID parentId);
}
