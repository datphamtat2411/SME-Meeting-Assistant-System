package com.sme.meetingassistant.api.media.repository;

import com.sme.meetingassistant.api.media.entity.ProcessingJobAttemptEntity;
import jakarta.persistence.LockModeType;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ProcessingJobAttemptRepository extends JpaRepository<ProcessingJobAttemptEntity, UUID> {

    List<ProcessingJobAttemptEntity> findAllByJobIdOrderByAttemptNumberAsc(UUID jobId);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select attempt from ProcessingJobAttemptEntity attempt where attempt.id = :attemptId and attempt.jobId = :jobId")
    Optional<ProcessingJobAttemptEntity> findByIdAndJobIdForUpdate(@Param("attemptId") UUID attemptId,
            @Param("jobId") UUID jobId);

}
