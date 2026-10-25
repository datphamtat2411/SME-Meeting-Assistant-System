package com.sme.meetingassistant.api.notification.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.OffsetDateTime;
import java.util.UUID;

@Entity
@Table(name = "notifications")
public class NotificationEntity {

	@Id
	private UUID id;

	@Column(name = "event_id", nullable = false)
	private UUID eventId;

	@Column(name = "recipient_id", nullable = false)
	private UUID recipientId;

	@Column(nullable = false, length = 100)
	private String type;

	@Column(nullable = false, length = 255)
	private String title;

	@Column(nullable = false, columnDefinition = "text")
	private String body;

	@Column(name = "resource_type", length = 100)
	private String resourceType;

	@Column(name = "resource_id")
	private UUID resourceId;

	@Column(name = "read_at")
	private OffsetDateTime readAt;

	@Version
	@Column(name = "row_version", nullable = false)
	private long concurrencyVersion;

	@Column(name = "created_at", nullable = false, updatable = false)
	private OffsetDateTime createdAt;

	protected NotificationEntity() {
	}

	public UUID getId() { return this.id; }
	public UUID getEventId() { return this.eventId; }
	public UUID getRecipientId() { return this.recipientId; }
	public String getType() { return this.type; }
	public String getTitle() { return this.title; }
	public String getBody() { return this.body; }
	public String getResourceType() { return this.resourceType; }
	public UUID getResourceId() { return this.resourceId; }
	public OffsetDateTime getReadAt() { return this.readAt; }
	public long getConcurrencyVersion() { return this.concurrencyVersion; }
	public OffsetDateTime getCreatedAt() { return this.createdAt; }
	public void markRead() { if (this.readAt == null) { this.readAt = OffsetDateTime.now(java.time.ZoneOffset.UTC); } }

}
