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
@Table(name = "processing_job_command_idempotency")
public class ProcessingJobCommandIdempotencyEntity {

    @Id
    private UUID id;

    @Column(name = "requester_id", nullable = false)
    private UUID requesterId;

    @Column(name = "idempotency_key", nullable = false, length = 255)
    private String idempotencyKey;

    @Column(name = "request_fingerprint", nullable = false, length = 64)
    private String requestFingerprint;

    @Column(name = "job_id", nullable = false)
    private UUID jobId;

    @Column(name = "command_type", nullable = false, length = 24)
    private String commandType;

    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;

    protected ProcessingJobCommandIdempotencyEntity() {
    }

    public ProcessingJobCommandIdempotencyEntity(UUID requesterId, String idempotencyKey,
            String requestFingerprint, UUID jobId, String commandType) {
        this.id = UUID.randomUUID();
        this.requesterId = requesterId;
        this.idempotencyKey = idempotencyKey;
        this.requestFingerprint = requestFingerprint;
        this.jobId = jobId;
        this.commandType = commandType;
    }

    @PrePersist
    void onCreate() {
        this.createdAt = OffsetDateTime.now(ZoneOffset.UTC);
    }

    public String getRequestFingerprint() { return this.requestFingerprint; }
    public UUID getJobId() { return this.jobId; }
    public String getCommandType() { return this.commandType; }
}
