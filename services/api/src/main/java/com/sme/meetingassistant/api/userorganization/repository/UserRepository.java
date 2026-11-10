package com.sme.meetingassistant.api.userorganization.repository;

import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.service.EmailNormalizer;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import jakarta.persistence.LockModeType;

public interface UserRepository extends JpaRepository<UserEntity, UUID>, JpaSpecificationExecutor<UserEntity> {
    Optional<UserEntity> findByEmailNormalized(String emailNormalized);

    @Query(value = """
        SELECT u.id AS "id", u.display_name AS "displayName", u.email AS "email",
               unit.name AS "organizationalUnitName"
          FROM users u
          LEFT JOIN organizational_units unit
            ON unit.id=u.primary_org_unit_id AND unit.status='ACTIVE'
         WHERE u.account_status='ACTIVE'
           AND u.id <> :actorId
           AND (lower(u.display_name) LIKE :pattern ESCAPE '\\'
                OR lower(u.email_normalized) LIKE :pattern ESCAPE '\\')
         ORDER BY lower(u.display_name) ASC, u.display_name ASC, u.id ASC
        """, countQuery = """
        SELECT count(*)
          FROM users u
          WHERE u.account_status='ACTIVE'
            AND u.id <> :actorId
           AND (lower(u.display_name) LIKE :pattern ESCAPE '\\'
                OR lower(u.email_normalized) LIKE :pattern ESCAPE '\\')
         """, nativeQuery = true)
    Page<MeetingParticipantCandidateProjection> findMeetingParticipantCandidates(
         @Param("actorId") UUID actorId, @Param("pattern") String pattern, Pageable pageable);

    interface MeetingParticipantCandidateProjection {
        UUID getId();
        String getDisplayName();
        String getEmail();
        String getOrganizationalUnitName();
    }

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
