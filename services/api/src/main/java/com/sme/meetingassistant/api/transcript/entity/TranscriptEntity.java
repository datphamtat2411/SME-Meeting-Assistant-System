package com.sme.meetingassistant.api.transcript.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

@Entity
@Table(name = "meeting_transcripts")
public class TranscriptEntity {

	@Id
	private UUID id;

	@Column(name = "meeting_id", nullable = false)
	private UUID meetingId;

	@Column(name = "version_number", nullable = false)
	private int versionNumber;

	@Column(name = "source_processing_job_id", nullable = false)
	private UUID sourceProcessingJobId;

	@Column(length = 35)
	private String language;

	@Column(name = "is_current", nullable = false)
	private boolean current;

	@Version
	@Column(name = "row_version", nullable = false)
	private long concurrencyVersion;

	@Column(name = "created_at", nullable = false, updatable = false)
	private OffsetDateTime createdAt;

	@Column(name = "updated_at", nullable = false)
	private OffsetDateTime updatedAt;

	protected TranscriptEntity() {
	}

	public TranscriptEntity(UUID meetingId, int versionNumber, UUID sourceProcessingJobId, String language) {
		this.id = UUID.randomUUID();
		this.meetingId = meetingId;
		this.versionNumber = versionNumber;
		this.sourceProcessingJobId = sourceProcessingJobId;
		this.language = language;
		this.current = true;
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
	public UUID getMeetingId() { return this.meetingId; }
	public int getVersionNumber() { return this.versionNumber; }
	public UUID getSourceProcessingJobId() { return this.sourceProcessingJobId; }
	public String getLanguage() { return this.language; }
	public boolean isCurrent() { return this.current; }
	public long getConcurrencyVersion() { return this.concurrencyVersion; }
	public OffsetDateTime getCreatedAt() { return this.createdAt; }
	public OffsetDateTime getUpdatedAt() { return this.updatedAt; }

	public void markNotCurrent() { this.current = false; }
	public void touch() { this.updatedAt = OffsetDateTime.now(ZoneOffset.UTC); }

}
