package com.sme.meetingassistant.api.transcript.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.common.PaginationMeta;
import com.sme.meetingassistant.api.meeting.security.CallerContextResolver;
import com.sme.meetingassistant.api.transcript.dto.TranscriptResponse;
import com.sme.meetingassistant.api.transcript.dto.TranscriptSegmentRevisionResponse;
import com.sme.meetingassistant.api.transcript.dto.TranscriptSegmentUpdateResponse;
import com.sme.meetingassistant.api.transcript.dto.TranscriptVersionResponse;
import com.sme.meetingassistant.api.transcript.dto.UpdateTranscriptSegmentRequest;
import com.sme.meetingassistant.api.transcript.service.TranscriptService;
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
@RequestMapping("/api/v1/meetings/{meetingId}/transcripts")
public class TranscriptController {

	private final TranscriptService transcriptService;
	private final ApiResponseFactory responseFactory;
	private final CallerContextResolver callerContextResolver;

	public TranscriptController(TranscriptService transcriptService, ApiResponseFactory responseFactory,
			CallerContextResolver callerContextResolver) {
		this.transcriptService = transcriptService;
		this.responseFactory = responseFactory;
		this.callerContextResolver = callerContextResolver;
	}

	@GetMapping("/current")
	public ResponseEntity<ApiResponse<TranscriptResponse>> current(@PathVariable UUID meetingId, Principal principal) {
		TranscriptResponse transcript = this.transcriptService.getCurrent(meetingId, callerId(principal));
		return ResponseEntity.ok().header(HttpHeaders.ETAG, etag(transcript.concurrencyVersion()))
				.body(this.responseFactory.success(transcript));
	}

	@GetMapping
	public ApiResponse<List<TranscriptVersionResponse>> list(@PathVariable UUID meetingId,
			@RequestParam(defaultValue = "0") @Min(0) int page,
			@RequestParam(defaultValue = "20") @Min(1) @Max(100) int size, Principal principal) {
		Page<TranscriptVersionResponse> transcripts = this.transcriptService.listVersions(meetingId,
				callerId(principal), PageRequest.of(page, size, Sort.by(Sort.Direction.DESC, "versionNumber")));
		return this.responseFactory.success(transcripts.getContent(), new PaginationMeta(transcripts.getNumber(),
				transcripts.getSize(), transcripts.getTotalElements(), transcripts.getTotalPages()));
	}

	@GetMapping("/{transcriptId}")
	public ResponseEntity<ApiResponse<TranscriptResponse>> get(@PathVariable UUID meetingId,
			@PathVariable UUID transcriptId, Principal principal) {
		TranscriptResponse transcript = this.transcriptService.get(meetingId, transcriptId, callerId(principal));
		return ResponseEntity.ok().header(HttpHeaders.ETAG, etag(transcript.concurrencyVersion()))
				.body(this.responseFactory.success(transcript));
	}

	@PatchMapping("/{transcriptId}/segments/{segmentId}")
	public ResponseEntity<ApiResponse<TranscriptSegmentUpdateResponse>> editSegment(@PathVariable UUID meetingId,
			@PathVariable UUID transcriptId, @PathVariable UUID segmentId,
			@RequestHeader(name = HttpHeaders.IF_MATCH, required = false) String ifMatch,
			@Valid @RequestBody UpdateTranscriptSegmentRequest request, Principal principal) {
		TranscriptSegmentUpdateResponse update = this.transcriptService.editSegment(meetingId, transcriptId, segmentId,
				callerId(principal), ifMatch, request);
		return ResponseEntity.ok().header(HttpHeaders.ETAG, etag(update.transcriptVersion()))
				.body(this.responseFactory.success(update));
	}

	@GetMapping("/{transcriptId}/segments/{segmentId}/revisions")
	public ApiResponse<List<TranscriptSegmentRevisionResponse>> revisions(@PathVariable UUID meetingId,
			@PathVariable UUID transcriptId, @PathVariable UUID segmentId, Principal principal) {
		return this.responseFactory.success(this.transcriptService.revisions(meetingId, transcriptId, segmentId,
				callerId(principal)));
	}

	private UUID callerId(Principal principal) {
		return this.callerContextResolver.resolve(principal).userId();
	}

	private static String etag(long version) { return "\"" + version + "\""; }

}
