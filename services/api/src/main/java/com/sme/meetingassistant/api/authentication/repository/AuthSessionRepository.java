package com.sme.meetingassistant.api.authentication.repository;

import com.sme.meetingassistant.api.authentication.entity.AuthSessionEntity;
import com.sme.meetingassistant.api.authentication.entity.AuthSessionStatus;
import jakarta.persistence.LockModeType;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/** Session-family repository; future login/revocation logic owns all locking decisions. */
public interface AuthSessionRepository extends JpaRepository<AuthSessionEntity, UUID> {
    List<AuthSessionEntity> findByUserIdAndStatusOrderByCreatedAtAsc(
        UUID userId, AuthSessionStatus status);

    long countByUserIdAndStatus(UUID userId, AuthSessionStatus status);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select session from AuthSessionEntity session where session.id = :sessionId")
    Optional<AuthSessionEntity> findByIdForUpdate(@Param("sessionId") UUID sessionId);
}
