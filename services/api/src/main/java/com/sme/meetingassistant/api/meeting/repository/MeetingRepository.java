package com.sme.meetingassistant.api.meeting.repository;

import com.sme.meetingassistant.api.meeting.entity.MeetingEntity;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;

public interface MeetingRepository extends JpaRepository<MeetingEntity, UUID>,
        JpaSpecificationExecutor<MeetingEntity> { }
