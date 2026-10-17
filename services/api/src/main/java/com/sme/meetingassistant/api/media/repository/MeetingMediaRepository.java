package com.sme.meetingassistant.api.media.repository;

import com.sme.meetingassistant.api.media.entity.MeetingMediaEntity;
import jakarta.persistence.LockModeType;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface MeetingMediaRepository extends JpaRepository<MeetingMediaEntity, UUID> {

	Optional<MeetingMediaEntity> findByIdAndMeetingId(UUID id, UUID meetingId);

	@Lock(LockModeType.PESSIMISTIC_WRITE)
	@Query("select media from MeetingMediaEntity media where media.id = :mediaId and media.meetingId = :meetingId")
	Optional<MeetingMediaEntity> findByIdAndMeetingIdForUpdate(@Param("mediaId") UUID mediaId,
			@Param("meetingId") UUID meetingId);

}
