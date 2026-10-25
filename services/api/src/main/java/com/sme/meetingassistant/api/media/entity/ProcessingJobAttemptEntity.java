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
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

@Entity
@Table(name = "processing_job_attempts")
public class ProcessingJobAttemptEntity {

    @Id
    private UUID id;

    @Column(name = "job_id", nullable = false)
    private UUID jobId;

    @Column(name = "attempt_number", nullable = false)
    private int attemptNumber;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 24)
    private ProcessingJobAttemptStatus status = ProcessingJobAttemptStatus.RUNNING;

    @Column(name = "failure_code", length = 100)
    private String failureCode;

    @Column(name = "started_at", nullable = false, updatable = false)
    private OffsetDateTime startedAt;

    @Column(name = "finished_at")
    private OffsetDateTime finishedAt;

    protected ProcessingJobAttemptEntity() {
    }

    public ProcessingJobAttemptEntity(UUID jobId, int attemptNumber) {
        this.id = UUID.randomUUID();
        this.jobId = jobId;
        this.attemptNumber = attemptNumber;
    }

    @PrePersist
    void onCreate() {
        if (this.startedAt == null) {
            this.startedAt = OffsetDateTime.now(ZoneOffset.UTC);
        }
    }

    public void complete(OffsetDateTime now) {
        requireRunning();
        this.status = ProcessingJobAttemptStatus.SUCCEEDED;
        this.finishedAt = now;
        this.failureCode = null;
    }

    public void fail(String code, OffsetDateTime now) {
        requireRunning();
        this.status = ProcessingJobAttemptStatus.FAILED;
        this.failureCode = code;
        this.finishedAt = now;
    }

    private void requireRunning() {
        if (this.status != ProcessingJobAttemptStatus.RUNNING) {
            throw new ResponseStatusException(HttpStatus.CONFLICT);
        }
    }

    public UUID getId() { return this.id; }
    public UUID getJobId() { return this.jobId; }
    public int getAttemptNumber() { return this.attemptNumber; }
    public ProcessingJobAttemptStatus getStatus() { return this.status; }
    public String getFailureCode() { return this.failureCode; }
    public OffsetDateTime getStartedAt() { return this.startedAt; }
    public OffsetDateTime getFinishedAt() { return this.finishedAt; }
}
