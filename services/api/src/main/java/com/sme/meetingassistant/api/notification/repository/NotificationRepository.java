package com.sme.meetingassistant.api.notification.repository;

import com.sme.meetingassistant.api.notification.entity.NotificationEntity;
import jakarta.persistence.LockModeType;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface NotificationRepository extends JpaRepository<NotificationEntity, UUID> {

	Optional<NotificationEntity> findByEventIdAndRecipientId(UUID eventId, UUID recipientId);

	Page<NotificationEntity> findAllByRecipientId(UUID recipientId, Pageable pageable);

	Page<NotificationEntity> findAllByRecipientIdAndReadAtIsNull(UUID recipientId, Pageable pageable);

	long countByRecipientIdAndReadAtIsNull(UUID recipientId);

	@Lock(LockModeType.PESSIMISTIC_WRITE)
	@Query("select n from NotificationEntity n where n.id = :id and n.recipientId = :recipientId")
	Optional<NotificationEntity> findByIdAndRecipientIdForUpdate(@Param("id") UUID id,
			@Param("recipientId") UUID recipientId);

	@Modifying
	@Query("update NotificationEntity n set n.readAt = CURRENT_TIMESTAMP, n.concurrencyVersion = n.concurrencyVersion + 1 "
			+ "where n.recipientId = :recipientId and n.readAt is null")
	int markAllUnreadRead(@Param("recipientId") UUID recipientId);

}
