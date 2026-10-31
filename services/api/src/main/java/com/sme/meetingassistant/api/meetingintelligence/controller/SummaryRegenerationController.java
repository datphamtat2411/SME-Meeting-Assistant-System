package com.sme.meetingassistant.api.meetingintelligence.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.meetingintelligence.dto.RegenerateSummaryResponse;
import com.sme.meetingassistant.api.meetingintelligence.service.SummaryRegenerationService;
import java.net.URI;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** MI-08 client admission. Worker execution remains a private internal port. */
@RestController
@RequestMapping("/api/v1/meetings/{meetingId}/summary")
public class SummaryRegenerationController {
    private final SummaryRegenerationService service;
    private final ApiResponseFactory responses;
    public SummaryRegenerationController(SummaryRegenerationService service,
            ApiResponseFactory responses) {
        this.service=service;this.responses=responses;
    }
    @PostMapping("/regenerate")
    public ResponseEntity<ApiResponse<RegenerateSummaryResponse>> regenerate(
            @PathVariable UUID meetingId,
            @RequestHeader(value="Idempotency-Key",required=false) String key) {
        var job=service.regenerate(meetingId,key);
        return ResponseEntity.status(HttpStatus.ACCEPTED)
            .location(URI.create("/api/v1/processing-jobs/"+job.processingJobId()))
            .cacheControl(CacheControl.noStore())
            .body(responses.success("Summary regeneration accepted.",job));
    }
}
