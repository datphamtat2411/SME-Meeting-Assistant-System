package com.sme.meetingassistant.api.media.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.media.dto.CreateProcessingJobRequest;
import com.sme.meetingassistant.api.media.dto.ProcessingJobResponse;
import com.sme.meetingassistant.api.media.service.MediaProcessingService;
import jakarta.validation.Valid;
import java.net.URI;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
public class ProcessingJobController {
    private final MediaProcessingService service;
    private final ApiResponseFactory responses;

    public ProcessingJobController(MediaProcessingService service, ApiResponseFactory responses) {
        this.service = service;
        this.responses = responses;
    }

    @PostMapping("/meetings/{meetingId}/processing-jobs")
    public ResponseEntity<ApiResponse<ProcessingJobResponse>> create(@PathVariable UUID meetingId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody CreateProcessingJobRequest request) {
        ProcessingJobResponse job = this.service.createJob(meetingId, request.mediaId(), idempotencyKey);
        return ResponseEntity.status(HttpStatus.ACCEPTED)
            .location(URI.create("/api/v1/processing-jobs/" + job.id()))
            .body(this.responses.success("Processing job accepted.", job));
    }

    @GetMapping("/meetings/{meetingId}/processing-jobs")
    public ApiResponse<List<ProcessingJobResponse>> list(@PathVariable UUID meetingId) {
        return this.responses.success(this.service.listJobs(meetingId));
    }

    @GetMapping("/processing-jobs/{jobId}")
    public ApiResponse<ProcessingJobResponse> get(@PathVariable UUID jobId) {
        return this.responses.success(this.service.getJob(jobId));
    }
}
