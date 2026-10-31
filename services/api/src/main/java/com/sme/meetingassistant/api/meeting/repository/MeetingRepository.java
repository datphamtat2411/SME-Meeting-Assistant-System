package com.sme.meetingassistant.api.meeting.repository;

import com.sme.meetingassistant.api.meeting.entity.MeetingEntity;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface MeetingRepository extends JpaRepository<MeetingEntity, UUID>,
        JpaSpecificationExecutor<MeetingEntity> {
    @Query(value = """
        SELECT meeting.id FROM meetings meeting JOIN users organizer ON organizer.id=meeting.organizer_user_id
         WHERE organizer.primary_org_unit_id IN (:unitIds)
        """, nativeQuery = true)
    List<UUID> findIdsByOrganizerOrgUnitIn(@Param("unitIds") Set<UUID> unitIds);
}
