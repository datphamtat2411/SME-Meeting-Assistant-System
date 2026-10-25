package com.sme.meetingassistant.api.actionitem.entity;

import com.sme.meetingassistant.api.actionitem.dto.ActionItemStatus;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

@Entity
@Table(name = "action_items")
public class ActionItemEntity {

	@Id
	private UUID id;

	@Column(name = "meeting_id", nullable = false)
	private UUID meetingId;

	@Column(name = "source_transcript_id", nullable = false)
	private UUID sourceTranscriptId;

	@Column(nullable = false, length = 500)
	private String title;

	@Column(name = "assignee_id")
	private UUID assigneeId;

	@Column(name = "due_date")
	private LocalDate dueDate;

	@Enumerated(EnumType.STRING)
	@Column(nullable = false, length = 20)
	private ActionItemStatus status;

	@Version
	@Column(name = "row_version", nullable = false)
	private long concurrencyVersion;

	@Column(name = "created_at", nullable = false, updatable = false)
	private OffsetDateTime createdAt;

	@Column(name = "updated_at", nullable = false)
	private OffsetDateTime updatedAt;

	protected ActionItemEntity() {
	}

	public ActionItemEntity(UUID meetingId, UUID sourceTranscriptId, String title, UUID assigneeId, LocalDate dueDate) {
		this.id = UUID.randomUUID();
		this.meetingId = meetingId;
		this.sourceTranscriptId = sourceTranscriptId;
		this.title = title;
		this.assigneeId = assigneeId;
		this.dueDate = dueDate;
		this.status = ActionItemStatus.PROPOSED;
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
	public UUID getMeetingId() { return this.meetingId; }
	public UUID getSourceTranscriptId() { return this.sourceTranscriptId; }
	public String getTitle() { return this.title; }
	public UUID getAssigneeId() { return this.assigneeId; }
	public LocalDate getDueDate() { return this.dueDate; }
	public ActionItemStatus getStatus() { return this.status; }
	public long getConcurrencyVersion() { return this.concurrencyVersion; }
	public OffsetDateTime getCreatedAt() { return this.createdAt; }
	public OffsetDateTime getUpdatedAt() { return this.updatedAt; }
	public void setStatus(ActionItemStatus status) { this.status = status; }
	public void setAssigneeId(UUID assigneeId) { this.assigneeId = assigneeId; }
	public void setDueDate(LocalDate dueDate) { this.dueDate = dueDate; }

}
