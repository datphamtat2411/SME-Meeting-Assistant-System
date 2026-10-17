package com.sme.meetingassistant.api.meeting.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

@Entity
@Table(name = "meeting_participants")
public class MeetingParticipantEntity {

	@Id
	private UUID id;

	@ManyToOne(fetch = FetchType.LAZY, optional = false)
	@JoinColumn(name = "meeting_id", nullable = false)
	private MeetingEntity meeting;

	@Column(name = "user_id", nullable = false)
	private UUID userId;

	@Enumerated(EnumType.STRING)
	@Column(nullable = false, length = 32)
	private ParticipantRole role;

	@Enumerated(EnumType.STRING)
	@Column(nullable = false, length = 32)
	private ParticipantStatus status = ParticipantStatus.INVITED;

	@Column(name = "created_at", nullable = false, updatable = false)
	private OffsetDateTime createdAt;

	@Column(name = "updated_at", nullable = false)
	private OffsetDateTime updatedAt;

	@Column(name = "removed_at")
	private OffsetDateTime removedAt;

	protected MeetingParticipantEntity() {
	}

	public MeetingParticipantEntity(UUID userId, ParticipantRole role) {
		this.id = UUID.randomUUID();
		this.userId = userId;
		this.role = role;
	}

	void attachTo(MeetingEntity meeting) { this.meeting = meeting; }

	public void remove() {
		this.status = ParticipantStatus.REMOVED;
		this.removedAt = OffsetDateTime.now(ZoneOffset.UTC);
	}

	@PrePersist
	void onCreate() {
		OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
		this.createdAt = now;
		this.updatedAt = now;
	}

	@PreUpdate
	void onUpdate() { this.updatedAt = OffsetDateTime.now(ZoneOffset.UTC); }

	public UUID getId() { return this.id; }
	public MeetingEntity getMeeting() { return this.meeting; }
	public UUID getUserId() { return this.userId; }
	public ParticipantRole getRole() { return this.role; }
	public ParticipantStatus getStatus() { return this.status; }
	public OffsetDateTime getCreatedAt() { return this.createdAt; }
	public OffsetDateTime getUpdatedAt() { return this.updatedAt; }
	public OffsetDateTime getRemovedAt() { return this.removedAt; }
}
