package com.sme.meetingassistant.api.meeting.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.meeting.dto.AddParticipantRequest;
import com.sme.meetingassistant.api.meeting.dto.ParticipantResponse;
import com.sme.meetingassistant.api.meeting.service.MeetingParticipantService;
import com.sme.meetingassistant.api.meeting.security.CallerContextResolver;
import jakarta.validation.Valid;
import java.net.URI;
import java.security.Principal;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/v1/meetings/{meetingId}/participants")
public class MeetingParticipantController {

	private final MeetingParticipantService participantService;
	private final ApiResponseFactory responseFactory;
	private final CallerContextResolver callerContextResolver;

	public MeetingParticipantController(MeetingParticipantService participantService, ApiResponseFactory responseFactory,
			CallerContextResolver callerContextResolver) {
		this.participantService = participantService;
		this.responseFactory = responseFactory;
		this.callerContextResolver = callerContextResolver;
	}

	@GetMapping
	public ApiResponse<List<ParticipantResponse>> list(@PathVariable UUID meetingId, Principal principal) {
		return this.responseFactory.success(this.participantService.list(meetingId, callerId(principal)));
	}

	@PostMapping
	public ResponseEntity<ApiResponse<ParticipantResponse>> add(@PathVariable UUID meetingId,
			@Valid @RequestBody AddParticipantRequest request, Principal principal) {
		ParticipantResponse participant = this.participantService.add(meetingId, callerId(principal), request);
		return ResponseEntity.created(URI.create("/api/v1/meetings/" + meetingId + "/participants/" + participant.id()))
				.body(this.responseFactory.success(participant));
	}

	@DeleteMapping("/{participantId}")
	public ResponseEntity<ApiResponse<ParticipantResponse>> remove(@PathVariable UUID meetingId,
			@PathVariable UUID participantId, Principal principal) {
		return ResponseEntity.ok(this.responseFactory.success(
				this.participantService.remove(meetingId, participantId, callerId(principal))));
	}

	private UUID callerId(Principal principal) { return this.callerContextResolver.resolve(principal).userId(); }
}
