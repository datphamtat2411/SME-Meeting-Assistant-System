package com.sme.meetingassistant.api.actionitem.entity;

import com.sme.meetingassistant.api.actionitem.dto.ActionItemStatus;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

@Entity
@Table(name = "action_item_change_history")
public class ActionItemChangeHistoryEntity {

	@Id
	private UUID id;

	@Column(name = "action_item_id", nullable = false)
	private UUID actionItemId;

	@Enumerated(EnumType.STRING)
	@Column(name = "previous_status", nullable = false, length = 20)
	private ActionItemStatus previousStatus;

	@Enumerated(EnumType.STRING)
	@Column(nullable = false, length = 20)
	private ActionItemStatus status;

	@Column(name = "previous_assignee_id")
	private UUID previousAssigneeId;

	@Column(name = "assignee_id")
	private UUID assigneeId;

	@Column(name = "previous_due_date")
	private LocalDate previousDueDate;

	@Column(name = "due_date")
	private LocalDate dueDate;

	@Column(name = "actor_id", nullable = false)
	private UUID actorId;

	@Column(name = "created_at", nullable = false, updatable = false)
	private OffsetDateTime createdAt;

	protected ActionItemChangeHistoryEntity() {
	}

	public ActionItemChangeHistoryEntity(UUID actionItemId, ActionItemStatus previousStatus, ActionItemStatus status,
			UUID previousAssigneeId, UUID assigneeId, LocalDate previousDueDate, LocalDate dueDate, UUID actorId) {
		this.id = UUID.randomUUID();
		this.actionItemId = actionItemId;
		this.previousStatus = previousStatus;
		this.status = status;
		this.previousAssigneeId = previousAssigneeId;
		this.assigneeId = assigneeId;
		this.previousDueDate = previousDueDate;
		this.dueDate = dueDate;
		this.actorId = actorId;
	}

	@PrePersist
	void onCreate() { this.createdAt = OffsetDateTime.now(ZoneOffset.UTC); }

	public UUID getId() { return this.id; }
	public UUID getActionItemId() { return this.actionItemId; }
	public ActionItemStatus getPreviousStatus() { return this.previousStatus; }
	public ActionItemStatus getStatus() { return this.status; }
	public UUID getPreviousAssigneeId() { return this.previousAssigneeId; }
	public UUID getAssigneeId() { return this.assigneeId; }
	public LocalDate getPreviousDueDate() { return this.previousDueDate; }
	public LocalDate getDueDate() { return this.dueDate; }
	public UUID getActorId() { return this.actorId; }
	public OffsetDateTime getCreatedAt() { return this.createdAt; }

}
