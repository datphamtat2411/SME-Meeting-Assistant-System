package com.sme.meetingassistant.api.media.service;

import com.sme.meetingassistant.api.media.dto.ProcessingJobAttemptResponse;
import com.sme.meetingassistant.api.media.entity.OutboxEventEntity;
import com.sme.meetingassistant.api.media.entity.ProcessingJobAttemptEntity;
import com.sme.meetingassistant.api.media.entity.ProcessingJobEntity;
import com.sme.meetingassistant.api.media.repository.OutboxEventRepository;
import com.sme.meetingassistant.api.media.repository.ProcessingJobAttemptRepository;
import com.sme.meetingassistant.api.media.repository.ProcessingJobRepository;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class ProcessingJobExecutionService {

    private final ProcessingJobRepository jobRepository;
    private final ProcessingJobAttemptRepository attemptRepository;
    private final OutboxEventRepository outboxRepository;

    public ProcessingJobExecutionService(ProcessingJobRepository jobRepository,
            ProcessingJobAttemptRepository attemptRepository, OutboxEventRepository outboxRepository) {
        this.jobRepository = jobRepository;
        this.attemptRepository = attemptRepository;
        this.outboxRepository = outboxRepository;
    }

    @Transactional
    public ProcessingJobAttemptResponse startAttempt(UUID jobId) {
        ProcessingJobEntity job = lockedJob(jobId);
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        int number = job.startAttempt(now);
        ProcessingJobAttemptEntity attempt = this.attemptRepository.saveAndFlush(
                new ProcessingJobAttemptEntity(jobId, number));
        this.jobRepository.flush();
        return ProcessingJobAttemptResponse.from(attempt);
    }

    @Transactional
    public void completeAttempt(UUID jobId, UUID attemptId) {
        ProcessingJobEntity job = lockedJob(jobId);
        ProcessingJobAttemptEntity attempt = lockedAttempt(jobId, attemptId);
        requireCurrentRunning(job, attempt);
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        attempt.complete(now);
        job.complete(now);
        this.attemptRepository.flush();
        this.jobRepository.flush();
    }

    @Transactional
    public void failAttempt(UUID jobId, UUID attemptId, String failureCode, boolean retryable) {
        if (failureCode == null || failureCode.isBlank() || failureCode.length() > 100) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
        }
        ProcessingJobEntity job = lockedJob(jobId);
        ProcessingJobAttemptEntity attempt = lockedAttempt(jobId, attemptId);
        requireCurrentRunning(job, attempt);
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        attempt.fail(failureCode, now);
        OffsetDateTime nextAttemptAt = job.fail(failureCode, retryable, now);
        this.attemptRepository.flush();
        this.jobRepository.flush();
        if (nextAttemptAt != null) {
            this.outboxRepository.save(new OutboxEventEntity(jobId, "processing.job.retry.requested.v1",
                    ProcessingJobService.jobPayload(job, nextAttemptAt), nextAttemptAt));
        }
    }

    private ProcessingJobEntity lockedJob(UUID jobId) {
        return this.jobRepository.findByIdForUpdate(jobId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
    }

    private ProcessingJobAttemptEntity lockedAttempt(UUID jobId, UUID attemptId) {
        return this.attemptRepository.findByIdAndJobIdForUpdate(attemptId, jobId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
    }

    private static void requireCurrentRunning(ProcessingJobEntity job, ProcessingJobAttemptEntity attempt) {
        if (attempt.getAttemptNumber() != job.getAttemptCount()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT);
        }
    }
}
