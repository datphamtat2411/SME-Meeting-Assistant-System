package com.sme.meetingassistant.api.intelligence.repository;

import com.sme.meetingassistant.api.intelligence.entity.MeetingDecisionStatusHistoryEntity;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface MeetingDecisionStatusHistoryRepository
		extends JpaRepository<MeetingDecisionStatusHistoryEntity, UUID> {

	List<MeetingDecisionStatusHistoryEntity> findAllByDecisionIdOrderByCreatedAtDescIdDesc(UUID decisionId);

}
