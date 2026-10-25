package com.sme.meetingassistant.api.media.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;

@Entity
@Table(name = "processing_artifacts")
public class ProcessingArtifactEntity {

    @Id
    private UUID id;

    @Column(name = "job_id", nullable = false)
    private UUID jobId;

    @Column(name = "attempt_id", nullable = false)
    private UUID attemptId;

    @Column(name = "artifact_type", nullable = false, length = 40)
    private String artifactType;

    @Column(name = "file_name", nullable = false, length = 255)
    private String fileName;

    @Column(name = "content_type", nullable = false, length = 100)
    private String contentType;

    @Column(name = "object_key", nullable = false, unique = true, length = 512)
    private String objectKey;

    @Column(name = "size_bytes", nullable = false)
    private long sizeBytes;

    @Column(length = 128)
    private String checksum;

    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;

    protected ProcessingArtifactEntity() {
    }

    public ProcessingArtifactEntity(UUID jobId, UUID attemptId, String artifactType, String fileName,
            String contentType, String objectKey, long sizeBytes, String checksum) {
        this.id = UUID.randomUUID();
        this.jobId = jobId;
        this.attemptId = attemptId;
        this.artifactType = artifactType;
        this.fileName = fileName;
        this.contentType = contentType;
        this.objectKey = objectKey;
        this.sizeBytes = sizeBytes;
        this.checksum = checksum;
    }

    @PrePersist
    void onCreate() {
        this.createdAt = OffsetDateTime.now(ZoneOffset.UTC);
    }

    public UUID getId() { return this.id; }
    public UUID getJobId() { return this.jobId; }
    public UUID getAttemptId() { return this.attemptId; }
    public String getArtifactType() { return this.artifactType; }
    public String getFileName() { return this.fileName; }
    public String getContentType() { return this.contentType; }
    public long getSizeBytes() { return this.sizeBytes; }
    public String getChecksum() { return this.checksum; }
    public OffsetDateTime getCreatedAt() { return this.createdAt; }
}
