package com.sme.meetingassistant.api.userorganization.repository;

import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.service.EmailNormalizer;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import jakarta.persistence.LockModeType;

public interface UserRepository extends JpaRepository<UserEntity, UUID>, JpaSpecificationExecutor<UserEntity> {
    Optional<UserEntity> findByEmailNormalized(String emailNormalized);

    /** Serialize admissions for one account; prevents concurrent logins exceeding five sessions. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select user from UserEntity user where user.id = :userId")
    Optional<UserEntity> findByIdForSessionAdmission(@Param("userId") UUID userId);
    boolean existsByEmailNormalized(String emailNormalized);
    List<UserEntity> findByPrimaryOrgUnitId(UUID primaryOrgUnitId);

    default Optional<UserEntity> findByLoginEmail(String email) {
        return findByEmailNormalized(EmailNormalizer.normalize(email));
    }

    default boolean existsByLoginEmail(String email) {
        return existsByEmailNormalized(EmailNormalizer.normalize(email));
    }
}
