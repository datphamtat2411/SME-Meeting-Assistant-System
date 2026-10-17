package com.sme.meetingassistant.api.meeting.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.common.PaginationMeta;
import com.sme.meetingassistant.api.meeting.dto.CreateMeetingRequest;
import com.sme.meetingassistant.api.meeting.dto.MeetingDetailResponse;
import com.sme.meetingassistant.api.meeting.dto.MeetingResponse;
import com.sme.meetingassistant.api.meeting.dto.ScheduleMeetingRequest;
import com.sme.meetingassistant.api.meeting.dto.UpdateMeetingRequest;
import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import com.sme.meetingassistant.api.meeting.service.MeetingService;
import com.sme.meetingassistant.api.meeting.security.CallerContextResolver;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import java.net.URI;
import java.security.Principal;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@Validated
@RestController
@RequestMapping("/api/v1/meetings")
public class MeetingController {

	private final MeetingService meetingService;
	private final ApiResponseFactory responseFactory;
	private final CallerContextResolver callerContextResolver;

	public MeetingController(MeetingService meetingService, ApiResponseFactory responseFactory,
			CallerContextResolver callerContextResolver) {
		this.meetingService = meetingService;
		this.responseFactory = responseFactory;
		this.callerContextResolver = callerContextResolver;
	}

	@PostMapping
	public ResponseEntity<ApiResponse<MeetingDetailResponse>> create(@Valid @RequestBody CreateMeetingRequest request,
			Principal principal) {
		MeetingDetailResponse meeting = this.meetingService.createMeeting(request, callerId(principal));
		return ResponseEntity.created(URI.create("/api/v1/meetings/" + meeting.id()))
				.body(this.responseFactory.success(meeting));
	}

	@GetMapping("/{meetingId}")
	public ResponseEntity<ApiResponse<MeetingDetailResponse>> get(@PathVariable UUID meetingId, Principal principal) {
		MeetingDetailResponse meeting = this.meetingService.getMeetingById(meetingId, callerId(principal));
		return ResponseEntity.ok().header(HttpHeaders.ETAG, etag(meeting.version()))
				.body(this.responseFactory.success(meeting));
	}

	@PatchMapping("/{meetingId}")
	public ResponseEntity<ApiResponse<MeetingDetailResponse>> update(@PathVariable UUID meetingId,
			@RequestHeader(name = HttpHeaders.IF_MATCH, required = false) String ifMatch,
			@Valid @RequestBody UpdateMeetingRequest request, Principal principal) {
		MeetingDetailResponse meeting = this.meetingService.updateMeeting(meetingId, callerId(principal), ifMatch, request);
		return ResponseEntity.ok().header(HttpHeaders.ETAG, etag(meeting.version()))
				.body(this.responseFactory.success(meeting));
	}

	@PostMapping("/{meetingId}/schedule")
	public ResponseEntity<ApiResponse<MeetingDetailResponse>> schedule(@PathVariable UUID meetingId,
			@Valid @RequestBody ScheduleMeetingRequest request, Principal principal) {
		return lifecycleResponse(this.meetingService.scheduleMeeting(meetingId, callerId(principal), request));
	}

	@PostMapping("/{meetingId}/start")
	public ResponseEntity<ApiResponse<MeetingDetailResponse>> start(@PathVariable UUID meetingId, Principal principal) {
		return lifecycleResponse(this.meetingService.transition(meetingId, callerId(principal), MeetingStatus.IN_PROGRESS));
	}

	@PostMapping("/{meetingId}/end")
	public ResponseEntity<ApiResponse<MeetingDetailResponse>> end(@PathVariable UUID meetingId, Principal principal) {
		return lifecycleResponse(this.meetingService.transition(meetingId, callerId(principal), MeetingStatus.ENDED));
	}

	@PostMapping("/{meetingId}/cancel")
	public ResponseEntity<ApiResponse<MeetingDetailResponse>> cancel(@PathVariable UUID meetingId, Principal principal) {
		return lifecycleResponse(this.meetingService.transition(meetingId, callerId(principal), MeetingStatus.CANCELLED));
	}

	@GetMapping
	public ApiResponse<java.util.List<MeetingResponse>> list(
			@RequestParam(required = false) MeetingStatus status,
			@RequestParam(required = false, name = "q") String query,
			@RequestParam(defaultValue = "0") @Min(0) int page,
			@RequestParam(defaultValue = "20") @Min(1) @Max(100) int size,
			@RequestParam(defaultValue = "createdAt,desc") String sort,
			Principal principal) {
		Pageable pageable = pageRequest(page, size, sort);
		Page<MeetingResponse> result = this.meetingService.listMeetings(callerId(principal), status, query, pageable);
		return this.responseFactory.success(result.getContent(), new PaginationMeta(result.getNumber(), result.getSize(),
				result.getTotalElements(), result.getTotalPages()));
	}

	private static Pageable pageRequest(int page, int size, String sort) {
		String[] parts = sort.split(",", -1);
		if (parts.length != 2 || !java.util.Set.of("createdAt", "title", "startTime", "status").contains(parts[0])) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
		}
		Sort.Direction direction;
		try {
			direction = Sort.Direction.fromString(parts[1]);
		}
		catch (IllegalArgumentException exception) {
			throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
		}
		return PageRequest.of(page, size, Sort.by(direction, parts[0]));
	}

	private UUID callerId(Principal principal) { return this.callerContextResolver.resolve(principal).userId(); }

	private static String etag(long version) { return "\"" + version + "\""; }

	private ResponseEntity<ApiResponse<MeetingDetailResponse>> lifecycleResponse(MeetingDetailResponse meeting) {
		return ResponseEntity.ok().header(HttpHeaders.ETAG, etag(meeting.version()))
				.body(this.responseFactory.success(meeting));
	}
}
