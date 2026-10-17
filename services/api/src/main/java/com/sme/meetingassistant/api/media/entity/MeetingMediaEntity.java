package com.sme.meetingassistant.api.media.entity;

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
@Table(name = "meeting_media")
public class MeetingMediaEntity {

	@Id
	private UUID id;

	@Column(name = "meeting_id", nullable = false)
	private UUID meetingId;

	@Column(name = "uploaded_by", nullable = false)
	private UUID uploadedBy;

	@Column(name = "original_file_name", nullable = false, length = 255)
	private String originalFileName;

	@Column(name = "file_extension", nullable = false, length = 8)
	private String fileExtension;

	@Column(name = "content_type", nullable = false, length = 100)
	private String contentType;

	@Column(name = "size_bytes", nullable = false)
	private long sizeBytes;

	@Column(name = "object_key", nullable = false, unique = true, length = 512)
	private String objectKey;

	@Enumerated(EnumType.STRING)
	@Column(name = "availability_status", nullable = false, length = 24)
	private MediaAvailabilityStatus availabilityStatus = MediaAvailabilityStatus.AVAILABLE;

	@Column(name = "uploaded_at", nullable = false, updatable = false)
	private OffsetDateTime uploadedAt;

	protected MeetingMediaEntity() {
	}

	public MeetingMediaEntity(UUID meetingId, UUID uploadedBy, String originalFileName, String fileExtension,
			String contentType, long sizeBytes, String objectKey) {
		this.id = UUID.randomUUID();
		this.meetingId = meetingId;
		this.uploadedBy = uploadedBy;
		this.originalFileName = originalFileName;
		this.fileExtension = fileExtension;
		this.contentType = contentType;
		this.sizeBytes = sizeBytes;
		this.objectKey = objectKey;
	}

	@PrePersist
	void onCreate() {
		this.uploadedAt = OffsetDateTime.now(ZoneOffset.UTC);
	}

	public UUID getId() { return this.id; }
	public UUID getMeetingId() { return this.meetingId; }
	public UUID getUploadedBy() { return this.uploadedBy; }
	public String getOriginalFileName() { return this.originalFileName; }
	public String getFileExtension() { return this.fileExtension; }
	public String getContentType() { return this.contentType; }
	public long getSizeBytes() { return this.sizeBytes; }
	public String getObjectKey() { return this.objectKey; }
	public MediaAvailabilityStatus getAvailabilityStatus() { return this.availabilityStatus; }
	public OffsetDateTime getUploadedAt() { return this.uploadedAt; }
}
