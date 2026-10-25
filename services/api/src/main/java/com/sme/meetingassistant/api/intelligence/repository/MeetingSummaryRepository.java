package com.sme.meetingassistant.api.intelligence.repository;

import com.sme.meetingassistant.api.intelligence.entity.MeetingSummaryEntity;
import jakarta.persistence.LockModeType;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface MeetingSummaryRepository extends JpaRepository<MeetingSummaryEntity, UUID> {

	Optional<MeetingSummaryEntity> findByMeetingIdAndCurrentTrue(UUID meetingId);

	Page<MeetingSummaryEntity> findAllByMeetingId(UUID meetingId, Pageable pageable);

	@Query("select coalesce(max(s.versionNumber), 0) from MeetingSummaryEntity s where s.meetingId = :meetingId")
	int findMaxVersionNumber(@Param("meetingId") UUID meetingId);

	@Lock(LockModeType.PESSIMISTIC_WRITE)
	@Query("select s from MeetingSummaryEntity s where s.meetingId = :meetingId and s.current = true")
	Optional<MeetingSummaryEntity> findCurrentForUpdate(@Param("meetingId") UUID meetingId);

}
