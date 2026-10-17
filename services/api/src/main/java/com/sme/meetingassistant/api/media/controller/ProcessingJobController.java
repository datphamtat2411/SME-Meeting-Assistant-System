package com.sme.meetingassistant.api.media.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.media.dto.ProcessingJobResponse;
import com.sme.meetingassistant.api.media.service.ProcessingJobService;
import com.sme.meetingassistant.api.meeting.security.CallerContextResolver;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.net.URI;
import java.security.Principal;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Validated
@RestController
public class ProcessingJobController {

	private final ProcessingJobService jobService;
	private final CallerContextResolver callerContextResolver;
	private final ApiResponseFactory responseFactory;

	public ProcessingJobController(ProcessingJobService jobService, CallerContextResolver callerContextResolver,
			ApiResponseFactory responseFactory) {
		this.jobService = jobService;
		this.callerContextResolver = callerContextResolver;
		this.responseFactory = responseFactory;
	}

	@PostMapping("/api/v1/meetings/{meetingId}/media/{mediaId}/processing-jobs")
	public ResponseEntity<ApiResponse<ProcessingJobResponse>> create(@PathVariable UUID meetingId,
			@PathVariable UUID mediaId,
			@RequestHeader("Idempotency-Key") @NotBlank @Size(max = 255) String idempotencyKey,
			Principal principal) {
		ProcessingJobResponse job = this.jobService.create(meetingId, mediaId,
				this.callerContextResolver.resolve(principal).userId(), idempotencyKey);
		return ResponseEntity.accepted().location(URI.create("/api/v1/processing-jobs/" + job.id()))
				.body(this.responseFactory.success(job));
	}

	@GetMapping("/api/v1/processing-jobs/{jobId}")
	public ApiResponse<ProcessingJobResponse> get(@PathVariable UUID jobId, Principal principal) {
		return this.responseFactory.success(this.jobService.get(jobId,
				this.callerContextResolver.resolve(principal).userId()));
	}

}
