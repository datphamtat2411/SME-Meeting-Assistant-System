package com.sme.meetingassistant.api.meeting.repository;

import com.sme.meetingassistant.api.meeting.entity.MeetingParticipantEntity;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface MeetingParticipantRepository extends JpaRepository<MeetingParticipantEntity, UUID> {
    boolean existsByMeetingIdAndUserIdAndRemovedAtIsNull(UUID meetingId, UUID userId);
    Optional<MeetingParticipantEntity> findByMeetingIdAndUserIdAndRemovedAtIsNull(UUID meetingId, UUID userId);
    List<MeetingParticipantEntity> findByMeetingIdOrderByAddedAtAsc(UUID meetingId);
    List<MeetingParticipantEntity> findByMeetingIdAndRemovedAtIsNull(UUID meetingId);

    /** Active counts and deterministic first-two previews for one authorized meeting page. */
    @Query(value = """
        SELECT ranked.meeting_id AS "meetingId",
               ranked.user_id AS "userId",
               ranked.participant_count AS "participantCount"
          FROM (
                SELECT mp.meeting_id,
                       mp.user_id,
                       count(*) OVER (PARTITION BY mp.meeting_id) AS participant_count,
                       row_number() OVER (
                           PARTITION BY mp.meeting_id
                           ORDER BY mp.added_at ASC, mp.id ASC
                       ) AS preview_rank
                  FROM meeting_participants mp
                 WHERE mp.removed_at IS NULL
                   AND mp.meeting_id IN (:meetingIds)
               ) ranked
         WHERE ranked.preview_rank <= 2
         ORDER BY ranked.meeting_id ASC, ranked.preview_rank ASC
        """, nativeQuery = true)
    List<ActiveParticipantPreview> findActivePreviewByMeetingIdIn(
            @Param("meetingIds") Collection<UUID> meetingIds);

    interface ActiveParticipantPreview {
        UUID getMeetingId();
        UUID getUserId();
        Long getParticipantCount();
    }
}
