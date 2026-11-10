package com.sme.meetingassistant.api.meeting.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.meeting.dto.MeetingOrganizerView;
import com.sme.meetingassistant.api.meeting.service.MeetingCoreService;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.UUID;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@Validated
@RequestMapping("/api/v1/meeting-organizers")
public class MeetingOrganizerController {
    private final MeetingCoreService service;
    private final ApiResponseFactory responses;

    public MeetingOrganizerController(MeetingCoreService service, ApiResponseFactory responses) {
        this.service = service;
        this.responses = responses;
    }

    @GetMapping
    public ApiResponse<List<MeetingOrganizerView>> list(
            @RequestParam(required = false) @Size(max = 200) String q,
            @RequestParam(defaultValue = "0") @Min(0) int page,
            @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
        return responses.successPage(service.listOrganizers(q, PageRequest.of(page, size)));
    }

    @GetMapping("/{organizerId}")
    public ResponseEntity<ApiResponse<MeetingOrganizerView>> get(@PathVariable UUID organizerId) {
        return ResponseEntity.ok(responses.success(service.organizer(organizerId)));
    }
}
