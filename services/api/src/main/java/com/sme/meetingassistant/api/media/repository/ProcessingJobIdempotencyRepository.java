package com.sme.meetingassistant.api.media.repository;

import com.sme.meetingassistant.api.media.entity.ProcessingJobIdempotencyEntity;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ProcessingJobIdempotencyRepository extends JpaRepository<ProcessingJobIdempotencyEntity, UUID> {

	Optional<ProcessingJobIdempotencyEntity> findByRequesterIdAndIdempotencyKey(UUID requesterId, String idempotencyKey);

}
