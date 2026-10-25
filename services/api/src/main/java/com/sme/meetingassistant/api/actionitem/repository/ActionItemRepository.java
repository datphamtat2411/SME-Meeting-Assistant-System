package com.sme.meetingassistant.api.actionitem.repository;

import com.sme.meetingassistant.api.actionitem.dto.ActionItemStatus;
import com.sme.meetingassistant.api.actionitem.entity.ActionItemEntity;
import jakarta.persistence.LockModeType;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ActionItemRepository extends JpaRepository<ActionItemEntity, UUID> {

	Page<ActionItemEntity> findAllByMeetingId(UUID meetingId, Pageable pageable);

	Page<ActionItemEntity> findAllByMeetingIdAndStatus(UUID meetingId, ActionItemStatus status, Pageable pageable);

	Optional<ActionItemEntity> findByIdAndMeetingId(UUID id, UUID meetingId);

	@Lock(LockModeType.PESSIMISTIC_WRITE)
	@Query("select a from ActionItemEntity a where a.id = :id and a.meetingId = :meetingId")
	Optional<ActionItemEntity> findByIdAndMeetingIdForUpdate(@Param("id") UUID id,
			@Param("meetingId") UUID meetingId);

}
