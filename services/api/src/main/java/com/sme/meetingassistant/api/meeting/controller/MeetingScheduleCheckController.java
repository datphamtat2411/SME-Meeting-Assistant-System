package com.sme.meetingassistant.api.meeting.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.meeting.dto.MeetingScheduleCheckRequest;
import com.sme.meetingassistant.api.meeting.dto.MeetingScheduleCheckView;
import com.sme.meetingassistant.api.meeting.service.MeetingScheduleCheckService;
import org.springframework.web.bind.annotation.*;

/** API-EP-MTG-009: pre-check only, commit still revalidates in T03/T04. */
@RestController
@RequestMapping("/api/v1/meeting-schedule-checks")
public class MeetingScheduleCheckController {
    private final MeetingScheduleCheckService service;
    private final ApiResponseFactory responses;
    public MeetingScheduleCheckController(MeetingScheduleCheckService service,ApiResponseFactory responses) {
        this.service=service;this.responses=responses;
    }
    @PostMapping
    public ApiResponse<MeetingScheduleCheckView> check(@RequestBody MeetingScheduleCheckRequest request) {
        return responses.success(service.check(request));
    }
}
