package com.sme.meetingassistant.api.userorganization.repository;
import com.sme.meetingassistant.api.userorganization.entity.OrganizationEntity;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
public interface OrganizationRepository extends JpaRepository<OrganizationEntity,UUID>{
    boolean existsBySlug(String slug);
    Optional<OrganizationEntity> findByIdAndStatus(UUID id, com.sme.meetingassistant.api.userorganization.entity.OrganizationStatus status);
}
