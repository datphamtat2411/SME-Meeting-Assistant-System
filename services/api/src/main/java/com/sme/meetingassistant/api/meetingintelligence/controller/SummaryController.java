package com.sme.meetingassistant.api.meetingintelligence.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.meetingintelligence.dto.EditSummaryRequest;
import com.sme.meetingassistant.api.meetingintelligence.dto.SummaryView;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceVersionTags;
import com.sme.meetingassistant.api.meetingintelligence.service.SummaryService;
import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Public Summary read/edit only; regeneration is owned by MI-08. */
@RestController
@RequestMapping("/api/v1/meetings/{meetingId}/summary")
public class SummaryController {
    private final SummaryService service;
    private final ApiResponseFactory responses;

    public SummaryController(SummaryService service, ApiResponseFactory responses) {
        this.service = service;
        this.responses = responses;
    }

    @GetMapping
    public ResponseEntity<ApiResponse<SummaryView>> current(@PathVariable UUID meetingId) {
        return privateSummary(service.current(meetingId));
    }

    @PatchMapping
    public ResponseEntity<ApiResponse<SummaryView>> edit(@PathVariable UUID meetingId,
            @RequestHeader(value = HttpHeaders.IF_MATCH, required = false) String ifMatch,
            @Valid @RequestBody EditSummaryRequest request) {
        return privateSummary(service.edit(meetingId, ifMatch, request));
    }

    private ResponseEntity<ApiResponse<SummaryView>> privateSummary(SummaryView view) {
        return ResponseEntity.ok()
            .eTag(IntelligenceVersionTags.summary(view.id(), view.versionNumber(), view.isStale()))
            .cacheControl(CacheControl.noStore())
            .body(responses.success(view));
    }
}
