package com.sme.meetingassistant.api.media.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

@Entity
@Table(name = "processing_job_idempotency", uniqueConstraints = @UniqueConstraint(
		name = "ux_processing_job_idempotency_requester_key", columnNames = { "requester_id", "idempotency_key" }))
public class ProcessingJobIdempotencyEntity {

	@Id
	private UUID id;

	@Column(name = "requester_id", nullable = false)
	private UUID requesterId;

	@Column(name = "idempotency_key", nullable = false, length = 255)
	private String idempotencyKey;

	@Column(name = "request_fingerprint", nullable = false, length = 64)
	private String requestFingerprint;

	@Column(name = "job_id", nullable = false, unique = true)
	private UUID jobId;

	@Column(name = "created_at", nullable = false, updatable = false)
	private OffsetDateTime createdAt;

	protected ProcessingJobIdempotencyEntity() {
	}

	public ProcessingJobIdempotencyEntity(UUID requesterId, String idempotencyKey, String requestFingerprint,
			UUID jobId) {
		this.id = UUID.randomUUID();
		this.requesterId = requesterId;
		this.idempotencyKey = idempotencyKey;
		this.requestFingerprint = requestFingerprint;
		this.jobId = jobId;
	}

	@PrePersist
	void onCreate() {
		this.createdAt = OffsetDateTime.now(ZoneOffset.UTC);
	}

	public UUID getRequesterId() { return this.requesterId; }
	public String getIdempotencyKey() { return this.idempotencyKey; }
	public String getRequestFingerprint() { return this.requestFingerprint; }
	public UUID getJobId() { return this.jobId; }
}
