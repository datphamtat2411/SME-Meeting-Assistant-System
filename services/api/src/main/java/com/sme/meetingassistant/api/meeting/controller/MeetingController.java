package com.sme.meetingassistant.api.meeting.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.meeting.dto.*;
import com.sme.meetingassistant.api.meeting.entity.MeetingEntity;
import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import com.sme.meetingassistant.api.meeting.service.*;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;
import java.net.URI;
import java.time.OffsetDateTime;
import java.util.*;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@Validated
@RequestMapping("/api/v1/meetings")
public class MeetingController {
    private static final Set<String> SORT_FIELDS =
        Set.of("createdAt","scheduledStartAt","title","status");
    private final MeetingCoreService service;
    private final ApiResponseFactory responses;

    public MeetingController(MeetingCoreService service, ApiResponseFactory responses) {
        this.service = service; this.responses = responses;
    }
    @PostMapping
    public ResponseEntity<ApiResponse<MeetingView>> create(
            @RequestHeader(value="Idempotency-Key", required=false) String idempotencyKey,
            @Valid @RequestBody CreateMeetingRequest request) {
        MeetingEntity meeting = service.create(request, idempotencyKey);
        return ResponseEntity.created(URI.create("/api/v1/meetings/"+meeting.getId()))
            .header(HttpHeaders.ETAG, MeetingVersionTags.of(meeting))
            .body(responses.success(MeetingView.from(meeting)));
    }
    @GetMapping("/{meetingId}")
    public ResponseEntity<ApiResponse<MeetingView>> detail(@PathVariable UUID meetingId) {
        return result(service.detail(meetingId));
    }
    @GetMapping
    public ApiResponse<List<MeetingView>> list(
        @RequestParam(required = false) MeetingStatus status,
        @RequestParam(required = false) @Size(max=200) String q,
        @RequestParam(required = false) UUID organizerId,
        @RequestParam(required = false) UUID roomId,
        @RequestParam(required = false) OffsetDateTime from,
        @RequestParam(required = false) OffsetDateTime to,
        @RequestParam(defaultValue="0") @Min(0) int page,
        @RequestParam(defaultValue="20") @Min(1) @Max(100) int size,
        @RequestParam(defaultValue="createdAt,desc") String sort) {
        String[] parts = sort.split(",", -1);
        if (parts.length != 2 || !SORT_FIELDS.contains(parts[0])) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        }
        Sort.Direction direction;
        try { direction = Sort.Direction.fromString(parts[1]); }
        catch (IllegalArgumentException bad) { throw new ResponseStatusException(HttpStatus.BAD_REQUEST); }
        return responses.successPage(service.list(status,q,organizerId,roomId,from,to,
            PageRequest.of(page,size,Sort.by(direction,parts[0]).and(Sort.by("id")))));
    }
    @PatchMapping("/{meetingId}")
    public ResponseEntity<ApiResponse<MeetingView>> update(@PathVariable UUID meetingId,
            @RequestHeader(value=HttpHeaders.IF_MATCH,required=false) String ifMatch,
            @RequestBody Map<String,Object> patch) {
        return result(service.update(meetingId,ifMatch,patch));
    }
    @PostMapping("/{meetingId}/schedule")
    public ResponseEntity<ApiResponse<MeetingView>> schedule(@PathVariable UUID meetingId,
            @RequestHeader(value=HttpHeaders.IF_MATCH,required=false) String ifMatch,
            @RequestBody(required=false) ScheduleMeetingRequest request) {
        return result(service.schedule(meetingId,ifMatch,request));
    }
    @PostMapping("/{meetingId}/start")
    public ResponseEntity<ApiResponse<MeetingView>> start(@PathVariable UUID meetingId,
            @RequestHeader(value=HttpHeaders.IF_MATCH,required=false) String ifMatch) {
        return result(service.start(meetingId,ifMatch));
    }
    @PostMapping("/{meetingId}/end")
    public ResponseEntity<ApiResponse<MeetingView>> end(@PathVariable UUID meetingId,
            @RequestHeader(value=HttpHeaders.IF_MATCH,required=false) String ifMatch) {
        return result(service.end(meetingId,ifMatch));
    }
    @PostMapping("/{meetingId}/cancel")
    public ResponseEntity<ApiResponse<MeetingView>> cancel(@PathVariable UUID meetingId,
            @RequestHeader(value=HttpHeaders.IF_MATCH,required=false) String ifMatch,
            @RequestBody(required=false) CancelMeetingRequest request) {
        return result(service.cancel(meetingId,ifMatch,request));
    }
    @GetMapping("/{meetingId}/participants")
    public ApiResponse<List<ParticipantView>> participants(@PathVariable UUID meetingId) {
        return responses.success(service.listParticipants(meetingId));
    }
    @PostMapping("/{meetingId}/participants")
    public ResponseEntity<ApiResponse<ParticipantView>> addParticipant(@PathVariable UUID meetingId,
            @RequestHeader(value=HttpHeaders.IF_MATCH,required=false) String ifMatch,
            @Valid @RequestBody AddParticipantRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED)
            .body(responses.success(service.addParticipant(meetingId,ifMatch,request)));
    }
    @DeleteMapping("/{meetingId}/participants/{userId}")
    public ResponseEntity<ApiResponse<MeetingView>> removeParticipant(@PathVariable UUID meetingId,
            @PathVariable UUID userId,
            @RequestHeader(value=HttpHeaders.IF_MATCH,required=false) String ifMatch) {
        service.removeParticipant(meetingId,userId,ifMatch);
        return result(service.detail(meetingId));
    }
    private ResponseEntity<ApiResponse<MeetingView>> result(MeetingEntity meeting) {
        return ResponseEntity.ok().header(HttpHeaders.ETAG,MeetingVersionTags.of(meeting))
            .body(responses.success(MeetingView.from(meeting)));
    }
}
