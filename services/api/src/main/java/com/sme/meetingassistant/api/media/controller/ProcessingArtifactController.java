package com.sme.meetingassistant.api.media.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.media.dto.ProcessingArtifactResponse;
import com.sme.meetingassistant.api.media.service.ProcessingArtifactService;
import com.sme.meetingassistant.api.meeting.security.CallerContextResolver;
import java.security.Principal;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ProcessingArtifactController {

    private final ProcessingArtifactService artifactService;
    private final CallerContextResolver callerContextResolver;
    private final ApiResponseFactory responseFactory;

    public ProcessingArtifactController(ProcessingArtifactService artifactService,
            CallerContextResolver callerContextResolver, ApiResponseFactory responseFactory) {
        this.artifactService = artifactService;
        this.callerContextResolver = callerContextResolver;
        this.responseFactory = responseFactory;
    }

    @GetMapping("/api/v1/processing-jobs/{jobId}/artifacts")
    public ApiResponse<List<ProcessingArtifactResponse>> list(@PathVariable UUID jobId, Principal principal) {
        return this.responseFactory.success(this.artifactService.list(jobId,
                this.callerContextResolver.resolve(principal).userId()));
    }
}
