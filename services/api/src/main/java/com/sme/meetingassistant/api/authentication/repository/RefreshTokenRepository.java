package com.sme.meetingassistant.api.authentication.repository;

import com.sme.meetingassistant.api.authentication.entity.RefreshTokenEntity;
import jakarta.persistence.LockModeType;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/** Rotation queries retain already-consumed hashes for family compromise detection. */
public interface RefreshTokenRepository extends JpaRepository<RefreshTokenEntity, UUID> {
    boolean existsByTokenHash(String tokenHash);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select token from RefreshTokenEntity token where token.tokenHash = :tokenHash")
    Optional<RefreshTokenEntity> findByTokenHashForUpdate(@Param("tokenHash") String tokenHash);

    List<RefreshTokenEntity> findBySessionIdOrderByIssuedAtAsc(UUID sessionId);
}
