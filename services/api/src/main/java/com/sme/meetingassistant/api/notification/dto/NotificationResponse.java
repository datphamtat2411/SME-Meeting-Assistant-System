package com.sme.meetingassistant.api.notification.dto;

import com.sme.meetingassistant.api.notification.entity.NotificationEntity;
import java.time.OffsetDateTime;
import java.util.UUID;

public record NotificationResponse(UUID id, UUID eventId, UUID recipientId, String type, String title, String body,
		String resourceType, UUID resourceId, OffsetDateTime readAt, long concurrencyVersion,
		OffsetDateTime createdAt) {

	public static NotificationResponse from(NotificationEntity entity) {
		return new NotificationResponse(entity.getId(), entity.getEventId(), entity.getRecipientId(), entity.getType(),
				entity.getTitle(), entity.getBody(), entity.getResourceType(), entity.getResourceId(), entity.getReadAt(),
				entity.getConcurrencyVersion(), entity.getCreatedAt());
	}

}
