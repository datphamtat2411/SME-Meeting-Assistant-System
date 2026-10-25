package com.sme.meetingassistant.api.media.repository;

import com.sme.meetingassistant.api.media.entity.ProcessingJobCommandIdempotencyEntity;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ProcessingJobCommandIdempotencyRepository
        extends JpaRepository<ProcessingJobCommandIdempotencyEntity, UUID> {

    Optional<ProcessingJobCommandIdempotencyEntity> findByRequesterIdAndIdempotencyKey(UUID requesterId,
            String idempotencyKey);

}
