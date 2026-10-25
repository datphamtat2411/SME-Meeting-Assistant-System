package com.sme.meetingassistant.api.actionitem.repository;

import com.sme.meetingassistant.api.actionitem.entity.ActionItemChangeHistoryEntity;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ActionItemChangeHistoryRepository extends JpaRepository<ActionItemChangeHistoryEntity, UUID> {

	List<ActionItemChangeHistoryEntity> findAllByActionItemIdOrderByCreatedAtDescIdDesc(UUID actionItemId);

}
