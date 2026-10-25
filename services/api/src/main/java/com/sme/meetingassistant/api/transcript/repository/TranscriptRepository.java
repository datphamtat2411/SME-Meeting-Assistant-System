package com.sme.meetingassistant.api.transcript.repository;

import com.sme.meetingassistant.api.transcript.entity.TranscriptEntity;
import jakarta.persistence.LockModeType;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;

public interface TranscriptRepository extends JpaRepository<TranscriptEntity, UUID> {

	Optional<TranscriptEntity> findByMeetingIdAndCurrentTrue(UUID meetingId);

	Optional<TranscriptEntity> findByIdAndMeetingId(UUID id, UUID meetingId);

	List<TranscriptEntity> findAllByMeetingIdOrderByVersionNumberDesc(UUID meetingId);

	Page<TranscriptEntity> findAllByMeetingId(UUID meetingId, Pageable pageable);

	@Query("select coalesce(max(t.versionNumber), 0) from TranscriptEntity t where t.meetingId = :meetingId")
	int findMaxVersionNumber(@Param("meetingId") UUID meetingId);

	@Lock(LockModeType.PESSIMISTIC_WRITE)
	@Query("select t from TranscriptEntity t where t.meetingId = :meetingId and t.current = true")
	Optional<TranscriptEntity> findCurrentForUpdate(@Param("meetingId") UUID meetingId);

	@Lock(LockModeType.PESSIMISTIC_WRITE)
	@Query("select t from TranscriptEntity t where t.id = :id and t.meetingId = :meetingId")
	Optional<TranscriptEntity> findByIdAndMeetingIdForUpdate(@Param("id") UUID id,
			@Param("meetingId") UUID meetingId);

}
