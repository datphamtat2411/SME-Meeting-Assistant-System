package com.sme.meetingassistant.api.media.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

@Entity
@Table(name = "processing_jobs")
public class ProcessingJobEntity {

	@Id
	private UUID id;

	@Column(name = "media_id", nullable = false)
	private UUID mediaId;

	@Column(name = "requested_by", nullable = false)
	private UUID requestedBy;

	@Enumerated(EnumType.STRING)
	@Column(nullable = false, length = 24)
	private ProcessingJobStatus status = ProcessingJobStatus.QUEUED;

	@Column(name = "attempt_count", nullable = false)
	private int attemptCount;

	@Column(name = "failure_code", length = 100)
	private String failureCode;

	@Column(name = "created_at", nullable = false, updatable = false)
	private OffsetDateTime createdAt;

	@Column(name = "updated_at", nullable = false)
	private OffsetDateTime updatedAt;

	@Column(name = "started_at")
	private OffsetDateTime startedAt;

	@Column(name = "finished_at")
	private OffsetDateTime finishedAt;

	@Version
	@Column(nullable = false)
	private long version;

	protected ProcessingJobEntity() {
	}

	public ProcessingJobEntity(UUID mediaId, UUID requestedBy) {
		this.id = UUID.randomUUID();
		this.mediaId = mediaId;
		this.requestedBy = requestedBy;
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
	public UUID getMediaId() { return this.mediaId; }
	public UUID getRequestedBy() { return this.requestedBy; }
	public ProcessingJobStatus getStatus() { return this.status; }
	public int getAttemptCount() { return this.attemptCount; }
	public String getFailureCode() { return this.failureCode; }
	public OffsetDateTime getCreatedAt() { return this.createdAt; }
	public OffsetDateTime getUpdatedAt() { return this.updatedAt; }
	public OffsetDateTime getStartedAt() { return this.startedAt; }
	public OffsetDateTime getFinishedAt() { return this.finishedAt; }
	public long getVersion() { return this.version; }
}
