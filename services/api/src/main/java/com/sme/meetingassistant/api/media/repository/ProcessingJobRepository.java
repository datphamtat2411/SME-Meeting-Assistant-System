package com.sme.meetingassistant.api.media.repository;

import com.sme.meetingassistant.api.media.entity.ProcessingJobEntity;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ProcessingJobRepository extends JpaRepository<ProcessingJobEntity, UUID> {

	Optional<ProcessingJobEntity> findByIdAndRequestedBy(UUID id, UUID requestedBy);

}
