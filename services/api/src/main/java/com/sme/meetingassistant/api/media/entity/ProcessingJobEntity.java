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
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

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

	@Column(name = "max_attempts", nullable = false)
	private int maxAttempts = 3;

	@Column(name = "next_attempt_at", nullable = false)
	private OffsetDateTime nextAttemptAt;

	@Column(name = "parent_job_id")
	private UUID parentJobId;

	@Enumerated(EnumType.STRING)
	@Column(name = "request_type", nullable = false, length = 24)
	private ProcessingJobRequestType requestType = ProcessingJobRequestType.INITIAL;

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

	public ProcessingJobEntity(UUID mediaId, UUID requestedBy, UUID parentJobId, ProcessingJobRequestType requestType) {
		this(mediaId, requestedBy);
		this.parentJobId = parentJobId;
		this.requestType = requestType;
	}

	@PrePersist
	void onCreate() {
		OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
		this.createdAt = now;
		this.updatedAt = now;
		if (this.nextAttemptAt == null) {
			this.nextAttemptAt = now;
		}
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
	public int getMaxAttempts() { return this.maxAttempts; }
	public OffsetDateTime getNextAttemptAt() { return this.nextAttemptAt; }
	public UUID getParentJobId() { return this.parentJobId; }
	public ProcessingJobRequestType getRequestType() { return this.requestType; }

	public int startAttempt(OffsetDateTime now) {
		if (this.status != ProcessingJobStatus.QUEUED || this.nextAttemptAt.isAfter(now)) {
			throw new ResponseStatusException(HttpStatus.CONFLICT);
		}
		if (this.attemptCount >= this.maxAttempts) {
			this.status = ProcessingJobStatus.FAILED;
			this.finishedAt = now;
			throw new ResponseStatusException(HttpStatus.CONFLICT);
		}
		this.attemptCount++;
		this.status = ProcessingJobStatus.RUNNING;
		this.startedAt = now;
		this.finishedAt = null;
		this.nextAttemptAt = now;
		this.failureCode = null;
		return this.attemptCount;
	}

	public void complete(OffsetDateTime now) {
		if (this.status != ProcessingJobStatus.RUNNING) {
			throw new ResponseStatusException(HttpStatus.CONFLICT);
		}
		this.status = ProcessingJobStatus.SUCCEEDED;
		this.finishedAt = now;
		this.failureCode = null;
	}

	public OffsetDateTime fail(String code, boolean retryable, OffsetDateTime now) {
		if (this.status != ProcessingJobStatus.RUNNING) {
			throw new ResponseStatusException(HttpStatus.CONFLICT);
		}
		this.failureCode = code;
		this.finishedAt = now;
		if (retryable && this.attemptCount < this.maxAttempts) {
			long delaySeconds = Math.min(1L << Math.max(0, this.attemptCount - 1), 300L);
			this.nextAttemptAt = now.plusSeconds(delaySeconds);
			this.status = ProcessingJobStatus.QUEUED;
			return this.nextAttemptAt;
		}
		this.status = ProcessingJobStatus.FAILED;
		return null;
	}

	public void retryNow(OffsetDateTime now) {
		if (this.status != ProcessingJobStatus.FAILED || this.attemptCount >= this.maxAttempts) {
			throw new ResponseStatusException(HttpStatus.CONFLICT);
		}
		this.status = ProcessingJobStatus.QUEUED;
		this.finishedAt = null;
		this.nextAttemptAt = now;
	}
}
