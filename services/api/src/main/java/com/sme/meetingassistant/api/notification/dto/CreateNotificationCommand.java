package com.sme.meetingassistant.api.notification.dto;

import java.util.UUID;

public record CreateNotificationCommand(UUID eventId, UUID recipientId, String type, String title, String body,
		String resourceType, UUID resourceId) {
}
