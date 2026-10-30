package com.sme.meetingassistant.api.media.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.media.MediaProperties;
import com.sme.meetingassistant.api.media.dto.CreateMediaUploadRequest;
import com.sme.meetingassistant.api.media.dto.FinalizeMediaResponse;
import com.sme.meetingassistant.api.media.dto.MediaAccessUrlResponse;
import com.sme.meetingassistant.api.media.dto.MediaUploadIntentResponse;
import com.sme.meetingassistant.api.media.service.MediaProcessingService;
import jakarta.validation.Valid;
import java.net.URI;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/meetings/{meetingId}/media")
public class MeetingMediaController {
    private final MediaProcessingService service;
    private final ApiResponseFactory responses;
    private final MediaProperties properties;

    public MeetingMediaController(MediaProcessingService service, ApiResponseFactory responses,
            MediaProperties properties) {
        this.service = service;
        this.responses = responses;
        this.properties = properties;
    }

    @GetMapping
    public ApiResponse<List<FinalizeMediaResponse>> list(@PathVariable UUID meetingId) {
        return this.responses.success(this.service.listMedia(meetingId));
    }

    @PostMapping("/uploads")
    public ResponseEntity<ApiResponse<MediaUploadIntentResponse>> createUpload(@PathVariable UUID meetingId,
            @RequestHeader("Idempotency-Key") String idempotencyKey,
            @Valid @RequestBody CreateMediaUploadRequest request) {
        MediaUploadIntentResponse result = this.service.createUploadIntent(meetingId, request, idempotencyKey);
        return ResponseEntity.created(URI.create("/api/v1/meetings/" + meetingId + "/media/" + result.mediaId()))
            .body(this.responses.success(result));
    }

    @PostMapping("/{mediaId}/finalize")
    public ApiResponse<FinalizeMediaResponse> finalizeUpload(@PathVariable UUID meetingId,
            @PathVariable UUID mediaId) {
        return this.responses.success(this.service.finalizeUpload(meetingId, mediaId));
    }

    @GetMapping("/{mediaId}")
    public ApiResponse<FinalizeMediaResponse> get(@PathVariable UUID meetingId, @PathVariable UUID mediaId) {
        return this.responses.success(this.service.getMedia(meetingId, mediaId));
    }

    @PostMapping("/{mediaId}/access-url")
    public ApiResponse<MediaAccessUrlResponse> accessUrl(@PathVariable UUID meetingId,
            @PathVariable UUID mediaId) {
        String url = this.service.mediaAccessUrl(meetingId, mediaId);
        var ttl = this.properties.getUpload().getDownloadUrlTtl();
        if (ttl == null || ttl.isNegative() || ttl.isZero() || ttl.compareTo(java.time.Duration.ofMinutes(5)) > 0) {
            ttl = java.time.Duration.ofMinutes(5);
        }
        return this.responses.success(new MediaAccessUrlResponse(url, OffsetDateTime.now().plus(ttl)));
    }
}
