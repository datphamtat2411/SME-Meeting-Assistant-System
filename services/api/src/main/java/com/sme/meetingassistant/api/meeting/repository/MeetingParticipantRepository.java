package com.sme.meetingassistant.api.meeting.repository;

import com.sme.meetingassistant.api.meeting.entity.MeetingParticipantEntity;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface MeetingParticipantRepository extends JpaRepository<MeetingParticipantEntity, UUID> {
    boolean existsByMeetingIdAndUserIdAndRemovedAtIsNull(UUID meetingId, UUID userId);
    Optional<MeetingParticipantEntity> findByMeetingIdAndUserIdAndRemovedAtIsNull(UUID meetingId, UUID userId);
    List<MeetingParticipantEntity> findByMeetingIdOrderByAddedAtAsc(UUID meetingId);
    List<MeetingParticipantEntity> findByMeetingIdAndRemovedAtIsNull(UUID meetingId);
}
