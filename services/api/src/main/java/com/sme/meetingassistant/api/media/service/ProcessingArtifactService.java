package com.sme.meetingassistant.api.media.service;

import com.sme.meetingassistant.api.media.dto.ProcessingArtifactResponse;
import com.sme.meetingassistant.api.media.entity.ProcessingArtifactEntity;
import com.sme.meetingassistant.api.media.entity.ProcessingJobAttemptStatus;
import com.sme.meetingassistant.api.media.repository.ProcessingArtifactRepository;
import com.sme.meetingassistant.api.media.repository.ProcessingJobAttemptRepository;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class ProcessingArtifactService {

    private final ProcessingJobService jobService;
    private final ProcessingJobAttemptRepository attemptRepository;
    private final ProcessingArtifactRepository artifactRepository;

    public ProcessingArtifactService(ProcessingJobService jobService,
            ProcessingJobAttemptRepository attemptRepository, ProcessingArtifactRepository artifactRepository) {
        this.jobService = jobService;
        this.attemptRepository = attemptRepository;
        this.artifactRepository = artifactRepository;
    }

    @Transactional
    public ProcessingArtifactResponse registerArtifact(UUID jobId, UUID attemptId, String artifactType,
            String fileName, String contentType, String objectKey, long sizeBytes, String checksum) {
        validate(artifactType, fileName, contentType, objectKey, sizeBytes, checksum);
        var attempt = this.attemptRepository.findByIdAndJobIdForUpdate(attemptId, jobId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        if (attempt.getStatus() != ProcessingJobAttemptStatus.SUCCEEDED) {
            throw new ResponseStatusException(HttpStatus.CONFLICT);
        }
        ProcessingArtifactEntity artifact = this.artifactRepository.saveAndFlush(new ProcessingArtifactEntity(jobId,
                attemptId, artifactType, fileName, contentType, objectKey, sizeBytes, checksum));
        return ProcessingArtifactResponse.from(artifact);
    }

    @Transactional(readOnly = true)
    public List<ProcessingArtifactResponse> list(UUID jobId, UUID callerId) {
        this.jobService.get(jobId, callerId);
        return this.artifactRepository.findAllByJobIdOrderByCreatedAtAsc(jobId).stream()
                .map(ProcessingArtifactResponse::from).toList();
    }

    private static void validate(String artifactType, String fileName, String contentType, String objectKey,
            long sizeBytes, String checksum) {
        if (artifactType == null || artifactType.isBlank() || artifactType.length() > 40
                || fileName == null || fileName.isBlank() || fileName.length() > 255
                || contentType == null || contentType.isBlank() || contentType.length() > 100
                || objectKey == null || objectKey.isBlank() || objectKey.length() > 512 || sizeBytes <= 0
                || checksum != null && checksum.length() > 128) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY);
        }
    }
}
