package com.sme.meetingassistant.api.transcript.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.transcript.dto.CorrectTranscriptSegmentRequest;
import com.sme.meetingassistant.api.transcript.dto.MapSpeakerRequest;
import com.sme.meetingassistant.api.transcript.dto.TranscriptViews.CorrectionView;
import com.sme.meetingassistant.api.transcript.dto.TranscriptViews.CoverageView;
import com.sme.meetingassistant.api.transcript.dto.TranscriptViews.SpeakerView;
import com.sme.meetingassistant.api.transcript.dto.TranscriptViews.TranscriptView;
import com.sme.meetingassistant.api.transcript.service.TranscriptReviewService;
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
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/meetings/{meetingId}")
public class TranscriptReviewController {
    private final TranscriptReviewService service;
    private final ApiResponseFactory responses;

    public TranscriptReviewController(TranscriptReviewService service, ApiResponseFactory responses) {
        this.service = service;
        this.responses = responses;
    }

    @GetMapping("/transcript")
    public ResponseEntity<ApiResponse<TranscriptView>> transcript(@PathVariable UUID meetingId) {
        return privateResponse(this.responses.success(this.service.current(meetingId)));
    }

    @GetMapping("/transcript/coverage")
    public ResponseEntity<ApiResponse<List<CoverageView>>> coverage(@PathVariable UUID meetingId) {
        return privateResponse(this.responses.success(this.service.coverage(meetingId)));
    }

    @PatchMapping("/transcript/segments/{segmentId}")
    public ResponseEntity<ApiResponse<CorrectionView>> correct(@PathVariable UUID meetingId,
            @PathVariable UUID segmentId, @RequestHeader(value = HttpHeaders.IF_MATCH, required = false) String ifMatch,
            @Valid @RequestBody CorrectTranscriptSegmentRequest request) {
        CorrectionView result = this.service.correct(meetingId, segmentId, ifMatch, request);
        return ResponseEntity.ok().eTag("\"s-" + segmentId + "-" + result.version() + "\"")
            .cacheControl(CacheControl.noStore()).body(this.responses.success(result));
    }

    @GetMapping("/speaker-clusters")
    public ResponseEntity<ApiResponse<List<SpeakerView>>> speakers(@PathVariable UUID meetingId) {
        return privateResponse(this.responses.success(this.service.speakers(meetingId)));
    }

    @PatchMapping("/speaker-clusters/{clusterId}")
    public ResponseEntity<ApiResponse<SpeakerView>> mapSpeaker(@PathVariable UUID meetingId,
            @PathVariable UUID clusterId, @RequestBody(required = false) MapSpeakerRequest request) {
        return privateResponse(this.responses.success(this.service.mapSpeaker(meetingId, clusterId, request)));
    }

    private static <T> ResponseEntity<ApiResponse<T>> privateResponse(ApiResponse<T> body) {
        return ResponseEntity.status(HttpStatus.OK).cacheControl(CacheControl.noStore()).body(body);
    }
}
