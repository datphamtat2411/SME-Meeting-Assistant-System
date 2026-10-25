package com.sme.meetingassistant.api.media.repository;

import com.sme.meetingassistant.api.media.entity.ProcessingJobEntity;
import jakarta.persistence.LockModeType;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ProcessingJobRepository extends JpaRepository<ProcessingJobEntity, UUID> {

	Optional<ProcessingJobEntity> findByIdAndRequestedBy(UUID id, UUID requestedBy);

	@Lock(LockModeType.PESSIMISTIC_WRITE)
	@Query("select job from ProcessingJobEntity job where job.id = :jobId")
	Optional<ProcessingJobEntity> findByIdForUpdate(@Param("jobId") UUID jobId);

}
