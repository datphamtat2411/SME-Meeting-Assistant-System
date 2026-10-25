package com.sme.meetingassistant.api.intelligence.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.common.PaginationMeta;
import com.sme.meetingassistant.api.intelligence.dto.MeetingDecisionResponse;
import com.sme.meetingassistant.api.intelligence.dto.MeetingDecisionStatusHistoryResponse;
import com.sme.meetingassistant.api.intelligence.dto.MeetingSummaryResponse;
import com.sme.meetingassistant.api.intelligence.dto.UpdateDecisionStatusRequest;
import com.sme.meetingassistant.api.intelligence.service.MeetingIntelligenceService;
import com.sme.meetingassistant.api.meeting.security.CallerContextResolver;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import java.security.Principal;
import java.util.List;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@Validated
@RestController
@RequestMapping("/api/v1/meetings/{meetingId}/intelligence")
public class MeetingIntelligenceController {

	private final MeetingIntelligenceService intelligenceService;
	private final ApiResponseFactory responseFactory;
	private final CallerContextResolver callerContextResolver;

	public MeetingIntelligenceController(MeetingIntelligenceService intelligenceService,
			ApiResponseFactory responseFactory, CallerContextResolver callerContextResolver) {
		this.intelligenceService = intelligenceService;
		this.responseFactory = responseFactory;
		this.callerContextResolver = callerContextResolver;
	}

	@GetMapping("/summaries/current")
	public ApiResponse<MeetingSummaryResponse> currentSummary(@PathVariable UUID meetingId, Principal principal) {
		return this.responseFactory.success(this.intelligenceService.getCurrentSummary(meetingId, callerId(principal)));
	}

	@GetMapping("/summaries")
	public ApiResponse<List<MeetingSummaryResponse>> summaries(@PathVariable UUID meetingId,
			@RequestParam(defaultValue = "0") @Min(0) int page,
			@RequestParam(defaultValue = "20") @Min(1) @Max(100) int size, Principal principal) {
		Page<MeetingSummaryResponse> summaries = this.intelligenceService.listSummaries(meetingId, callerId(principal),
				PageRequest.of(page, size, Sort.by(Sort.Direction.DESC, "versionNumber")));
		return this.responseFactory.success(summaries.getContent(), pagination(summaries));
	}

	@GetMapping("/decisions")
	public ApiResponse<List<MeetingDecisionResponse>> decisions(@PathVariable UUID meetingId,
			@RequestParam(defaultValue = "0") @Min(0) int page,
			@RequestParam(defaultValue = "20") @Min(1) @Max(100) int size, Principal principal) {
		Page<MeetingDecisionResponse> decisions = this.intelligenceService.listDecisions(meetingId,
				callerId(principal), PageRequest.of(page, size, Sort.by(Sort.Direction.DESC, "createdAt")));
		return this.responseFactory.success(decisions.getContent(), pagination(decisions));
	}

	@PatchMapping("/decisions/{decisionId}")
	public ResponseEntity<ApiResponse<MeetingDecisionResponse>> reviewDecision(@PathVariable UUID meetingId,
			@PathVariable UUID decisionId,
			@RequestHeader(name = HttpHeaders.IF_MATCH, required = false) String ifMatch,
			@Valid @RequestBody UpdateDecisionStatusRequest request, Principal principal) {
		MeetingDecisionResponse decision = this.intelligenceService.reviewDecision(meetingId, decisionId,
				callerId(principal), ifMatch, request);
		return ResponseEntity.ok().header(HttpHeaders.ETAG, etag(decision.concurrencyVersion()))
				.body(this.responseFactory.success(decision));
	}

	@GetMapping("/decisions/{decisionId}/history")
	public ApiResponse<List<MeetingDecisionStatusHistoryResponse>> decisionHistory(@PathVariable UUID meetingId,
			@PathVariable UUID decisionId, Principal principal) {
		return this.responseFactory.success(this.intelligenceService.decisionHistory(meetingId, decisionId,
				callerId(principal)));
	}

	private UUID callerId(Principal principal) {
		return this.callerContextResolver.resolve(principal).userId();
	}

	private static PaginationMeta pagination(Page<?> page) {
		return new PaginationMeta(page.getNumber(), page.getSize(), page.getTotalElements(), page.getTotalPages());
	}

	private static String etag(long version) { return "\"" + version + "\""; }

}
