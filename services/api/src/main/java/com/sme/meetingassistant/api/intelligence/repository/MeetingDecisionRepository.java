package com.sme.meetingassistant.api.intelligence.repository;

import com.sme.meetingassistant.api.intelligence.entity.MeetingDecisionEntity;
import jakarta.persistence.LockModeType;
import java.util.Optional;
import java.util.List;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface MeetingDecisionRepository extends JpaRepository<MeetingDecisionEntity, UUID> {

	Page<MeetingDecisionEntity> findAllByMeetingId(UUID meetingId, Pageable pageable);

	Page<MeetingDecisionEntity> findAllBySummaryId(UUID summaryId, Pageable pageable);

	List<MeetingDecisionEntity> findAllBySummaryIdOrderByCreatedAtAsc(UUID summaryId);

	@Lock(LockModeType.PESSIMISTIC_WRITE)
	@Query("select d from MeetingDecisionEntity d where d.id = :id and d.meetingId = :meetingId")
	Optional<MeetingDecisionEntity> findByIdAndMeetingIdForUpdate(@Param("id") UUID id,
			@Param("meetingId") UUID meetingId);

	Optional<MeetingDecisionEntity> findByIdAndMeetingId(UUID id, UUID meetingId);

}
