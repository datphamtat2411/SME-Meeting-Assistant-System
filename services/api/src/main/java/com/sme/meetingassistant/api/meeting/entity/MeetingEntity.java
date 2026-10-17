package com.sme.meetingassistant.api.meeting.entity;

import jakarta.persistence.CascadeType;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.OneToMany;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@Entity
@Table(name = "meetings")
public class MeetingEntity {

	@Id
	private UUID id;

	@Column(nullable = false, length = 255)
	private String title;

	@Column(columnDefinition = "text")
	private String description;

	@Enumerated(EnumType.STRING)
	@Column(nullable = false, length = 32)
	private MeetingStatus status = MeetingStatus.DRAFT;

	@Column(name = "organizer_id", nullable = false)
	private UUID organizerId;

	@Column(name = "start_time")
	private OffsetDateTime startTime;

	@Column(name = "end_time")
	private OffsetDateTime endTime;

	@Version
	@Column(nullable = false)
	private long version;

	@Column(name = "created_at", nullable = false, updatable = false)
	private OffsetDateTime createdAt;

	@Column(name = "updated_at", nullable = false)
	private OffsetDateTime updatedAt;

	@OneToMany(mappedBy = "meeting", cascade = CascadeType.ALL)
	private List<MeetingParticipantEntity> participants = new ArrayList<>();

	protected MeetingEntity() {
	}

	public MeetingEntity(String title, UUID organizerId) {
		this(title, null, organizerId);
	}

	public MeetingEntity(String title, String description, UUID organizerId) {
		this.id = UUID.randomUUID();
		this.title = title;
		this.description = description;
		this.organizerId = organizerId;
	}

	public void addParticipant(MeetingParticipantEntity participant) {
		participant.attachTo(this);
		this.participants.add(participant);
	}

	@PrePersist
	void onCreate() {
		OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
		this.createdAt = now;
		this.updatedAt = now;
	}

	@PreUpdate
	void onUpdate() {
		this.updatedAt = OffsetDateTime.now(ZoneOffset.UTC);
	}

	public UUID getId() { return this.id; }
	public String getTitle() { return this.title; }
	public String getDescription() { return this.description; }
	public MeetingStatus getStatus() { return this.status; }
	public UUID getOrganizerId() { return this.organizerId; }
	public OffsetDateTime getStartTime() { return this.startTime; }
	public OffsetDateTime getEndTime() { return this.endTime; }
	public long getVersion() { return this.version; }
	public OffsetDateTime getCreatedAt() { return this.createdAt; }
	public OffsetDateTime getUpdatedAt() { return this.updatedAt; }
	public List<MeetingParticipantEntity> getParticipants() { return List.copyOf(this.participants); }

	public void updateDetails(String title, String description) {
		this.title = title;
		this.description = description;
	}

	public void setSchedule(OffsetDateTime startTime, OffsetDateTime endTime) {
		this.startTime = startTime;
		this.endTime = endTime;
	}

	public void transitionTo(MeetingStatus status) { this.status = status; }

	public void touch() { this.updatedAt = OffsetDateTime.now(ZoneOffset.UTC); }
}
