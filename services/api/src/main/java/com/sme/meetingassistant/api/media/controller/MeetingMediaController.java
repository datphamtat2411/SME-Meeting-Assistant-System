package com.sme.meetingassistant.api.media.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.media.dto.MeetingMediaResponse;
import com.sme.meetingassistant.api.media.service.MeetingMediaService;
import com.sme.meetingassistant.api.meeting.security.CallerContextResolver;
import java.net.URI;
import java.security.Principal;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/v1/meetings/{meetingId}/media")
public class MeetingMediaController {

	private final MeetingMediaService mediaService;
	private final CallerContextResolver callerContextResolver;
	private final ApiResponseFactory responseFactory;

	public MeetingMediaController(MeetingMediaService mediaService, CallerContextResolver callerContextResolver,
			ApiResponseFactory responseFactory) {
		this.mediaService = mediaService;
		this.callerContextResolver = callerContextResolver;
		this.responseFactory = responseFactory;
	}

	@PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
	public ResponseEntity<ApiResponse<MeetingMediaResponse>> upload(@PathVariable UUID meetingId,
			@RequestPart("file") MultipartFile file, Principal principal) {
		MeetingMediaResponse media = this.mediaService.upload(meetingId,
				this.callerContextResolver.resolve(principal).userId(), file);
		return ResponseEntity.created(URI.create("/api/v1/meetings/" + meetingId + "/media/" + media.id()))
				.body(this.responseFactory.success(media));
	}

}
