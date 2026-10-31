package com.sme.meetingassistant.api.meetingintelligence.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.meetingintelligence.dto.CreateDecisionRequest;
import com.sme.meetingassistant.api.meetingintelligence.dto.DecisionView;
import com.sme.meetingassistant.api.meetingintelligence.dto.EditDecisionRequest;
import com.sme.meetingassistant.api.meetingintelligence.service.DecisionService;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceVersionTags;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** MI-05 CRUD and MI-06 explicit human review of proposed Decisions. */
@RestController
@RequestMapping("/api/v1/meetings/{meetingId}/decisions")
public class DecisionController {
    private final DecisionService service;
    private final ApiResponseFactory responses;

    public DecisionController(DecisionService service, ApiResponseFactory responses) {
        this.service = service;
        this.responses = responses;
    }

    @GetMapping
    public ResponseEntity<ApiResponse<List<DecisionView>>> list(@PathVariable UUID meetingId,
            @RequestParam(required = false) String status,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(responses.successPage(service.list(meetingId, status, page, size)));
    }

    @PostMapping
    public ResponseEntity<ApiResponse<DecisionView>> create(@PathVariable UUID meetingId,
            @Valid @RequestBody CreateDecisionRequest request) {
        return decision(service.create(meetingId, request), HttpStatus.CREATED);
    }

    @PatchMapping("/{decisionId}")
    public ResponseEntity<ApiResponse<DecisionView>> edit(@PathVariable UUID meetingId,
            @PathVariable UUID decisionId,
            @RequestHeader(value = HttpHeaders.IF_MATCH, required = false) String ifMatch,
            @Valid @RequestBody EditDecisionRequest request) {
        return decision(service.edit(meetingId, decisionId, ifMatch, request), HttpStatus.OK);
    }

    @PostMapping("/{decisionId}/confirm")
    public ResponseEntity<ApiResponse<DecisionView>> confirm(@PathVariable UUID meetingId,
            @PathVariable UUID decisionId,
            @RequestHeader(value = HttpHeaders.IF_MATCH, required = false) String ifMatch) {
        return decision(service.confirm(meetingId, decisionId, ifMatch), HttpStatus.OK);
    }

    @PostMapping("/{decisionId}/reject")
    public ResponseEntity<ApiResponse<DecisionView>> reject(@PathVariable UUID meetingId,
            @PathVariable UUID decisionId,
            @RequestHeader(value = HttpHeaders.IF_MATCH, required = false) String ifMatch) {
        return decision(service.reject(meetingId, decisionId, ifMatch), HttpStatus.OK);
    }

    private ResponseEntity<ApiResponse<DecisionView>> decision(DecisionView view, HttpStatus status) {
        return ResponseEntity.status(status)
            .eTag(IntelligenceVersionTags.decision(view.id(), view.version()))
            .cacheControl(CacheControl.noStore())
            .body(responses.success(view));
    }
}
