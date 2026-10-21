package com.sme.meetingassistant.api.userorganization.repository;
import com.sme.meetingassistant.api.userorganization.entity.OrganizationMembershipEntity;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
public interface OrganizationMembershipRepository extends JpaRepository<OrganizationMembershipEntity,UUID>{
    Optional<OrganizationMembershipEntity> findByOrganizationIdAndUserId(UUID orgId,UUID userId);
    Optional<OrganizationMembershipEntity> findByOrganizationIdAndUserIdAndStatus(UUID orgId,UUID userId,String status);
    List<OrganizationMembershipEntity> findByUserIdAndStatusOrderByCreatedAtDesc(UUID userId,String status);
    List<OrganizationMembershipEntity> findByOrganizationIdAndStatusOrderByCreatedAtAsc(UUID orgId,String status);
    long countByOrganizationIdAndRoleAndStatus(UUID orgId,com.sme.meetingassistant.api.userorganization.entity.OrganizationRole role,String status);
}
