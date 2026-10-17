package com.sme.meetingassistant.api.meeting.repository;

import com.sme.meetingassistant.api.meeting.entity.MeetingParticipantEntity;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface MeetingParticipantRepository extends JpaRepository<MeetingParticipantEntity, UUID> {
	List<MeetingParticipantEntity> findByMeetingIdOrderByCreatedAtAsc(UUID meetingId);
	Optional<MeetingParticipantEntity> findByIdAndMeetingId(UUID id, UUID meetingId);
	boolean existsByMeetingIdAndUserIdAndStatusIn(UUID meetingId, UUID userId, List<com.sme.meetingassistant.api.meeting.entity.ParticipantStatus> statuses);
}
