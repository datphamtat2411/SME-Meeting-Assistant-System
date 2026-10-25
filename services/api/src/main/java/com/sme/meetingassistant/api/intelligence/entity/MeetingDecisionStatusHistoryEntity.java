package com.sme.meetingassistant.api.intelligence.entity;

import com.sme.meetingassistant.api.intelligence.dto.MeetingDecisionStatus;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

@Entity
@Table(name = "meeting_decision_status_history")
public class MeetingDecisionStatusHistoryEntity {

	@Id
	private UUID id;

	@Column(name = "decision_id", nullable = false)
	private UUID decisionId;

	@Enumerated(EnumType.STRING)
	@Column(name = "previous_status", nullable = false, length = 20)
	private MeetingDecisionStatus previousStatus;

	@Enumerated(EnumType.STRING)
	@Column(nullable = false, length = 20)
	private MeetingDecisionStatus status;

	@Column(name = "actor_id", nullable = false)
	private UUID actorId;

	@Column(name = "created_at", nullable = false, updatable = false)
	private OffsetDateTime createdAt;

	protected MeetingDecisionStatusHistoryEntity() {
	}

	public MeetingDecisionStatusHistoryEntity(UUID decisionId, MeetingDecisionStatus previousStatus,
			MeetingDecisionStatus status, UUID actorId) {
		this.id = UUID.randomUUID();
		this.decisionId = decisionId;
		this.previousStatus = previousStatus;
		this.status = status;
		this.actorId = actorId;
	}

	@PrePersist
	void onCreate() { this.createdAt = OffsetDateTime.now(ZoneOffset.UTC); }

	public UUID getId() { return this.id; }
	public UUID getDecisionId() { return this.decisionId; }
	public MeetingDecisionStatus getPreviousStatus() { return this.previousStatus; }
	public MeetingDecisionStatus getStatus() { return this.status; }
	public UUID getActorId() { return this.actorId; }
	public OffsetDateTime getCreatedAt() { return this.createdAt; }

}
