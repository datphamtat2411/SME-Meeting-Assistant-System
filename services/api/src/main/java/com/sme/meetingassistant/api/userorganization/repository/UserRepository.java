package com.sme.meetingassistant.api.userorganization.repository;

import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.service.EmailNormalizer;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;

public interface UserRepository extends JpaRepository<UserEntity, UUID>, JpaSpecificationExecutor<UserEntity> {
    Optional<UserEntity> findByEmailNormalized(String emailNormalized);
    boolean existsByEmailNormalized(String emailNormalized);
    List<UserEntity> findByPrimaryOrgUnitId(UUID primaryOrgUnitId);

    default Optional<UserEntity> findByLoginEmail(String email) {
        return findByEmailNormalized(EmailNormalizer.normalize(email));
    }

    default boolean existsByLoginEmail(String email) {
        return existsByEmailNormalized(EmailNormalizer.normalize(email));
    }
}
