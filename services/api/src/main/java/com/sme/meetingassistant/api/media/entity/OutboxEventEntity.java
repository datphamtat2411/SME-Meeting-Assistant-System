package com.sme.meetingassistant.api.media.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

@Entity
@Table(name = "outbox_events")
public class OutboxEventEntity {

	@Id
	private UUID id;

	@Column(name = "aggregate_type", nullable = false, length = 100)
	private String aggregateType;

	@Column(name = "aggregate_id", nullable = false)
	private UUID aggregateId;

	@Column(name = "event_type", nullable = false, length = 150)
	private String eventType;

	@JdbcTypeCode(SqlTypes.JSON)
	@Column(nullable = false, columnDefinition = "jsonb")
	private String payload;

	@Column(name = "created_at", nullable = false, updatable = false)
	private OffsetDateTime createdAt;

	@Column(name = "published_at")
	private OffsetDateTime publishedAt;

	@Column(name = "delivery_attempts", nullable = false)
	private int deliveryAttempts;

	@Column(name = "last_error", length = 500)
	private String lastError;

	protected OutboxEventEntity() {
	}

	public OutboxEventEntity(UUID aggregateId, String eventType, String payload) {
		this.id = UUID.randomUUID();
		this.aggregateType = "PROCESSING_JOB";
		this.aggregateId = aggregateId;
		this.eventType = eventType;
		this.payload = payload;
	}

	@PrePersist
	void onCreate() {
		this.createdAt = OffsetDateTime.now(ZoneOffset.UTC);
	}

	public UUID getId() { return this.id; }
	public UUID getAggregateId() { return this.aggregateId; }
	public String getEventType() { return this.eventType; }
	public String getPayload() { return this.payload; }
}
