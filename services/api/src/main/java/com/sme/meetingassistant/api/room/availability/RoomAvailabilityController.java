package com.sme.meetingassistant.api.room.availability;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import java.time.OffsetDateTime;
import org.springframework.format.annotation.DateTimeFormat;
import java.util.List;
import org.springframework.data.domain.PageRequest;
import org.springframework.web.bind.annotation.*;
import org.springframework.validation.annotation.Validated;

/** Canonical API-EP-ROOM-006. Preview never reserves a physical room. */
@RestController
@Validated
@RequestMapping("/api/v1/rooms/availability")
public class RoomAvailabilityController {
    private final RoomAvailabilityService service;
    private final ApiResponseFactory responses;
    public RoomAvailabilityController(RoomAvailabilityService service,ApiResponseFactory responses) {
        this.service=service; this.responses=responses;
    }

    @GetMapping
    public ApiResponse<List<RoomAvailabilityService.AvailableRoom>> available(
            @RequestParam @DateTimeFormat(iso=DateTimeFormat.ISO.DATE_TIME) OffsetDateTime start,
            @RequestParam @DateTimeFormat(iso=DateTimeFormat.ISO.DATE_TIME) OffsetDateTime end,
            @RequestParam(required=false) String q,
            @RequestParam(required=false) Integer minCapacity,
            @RequestParam(required=false) Integer participantCount,
            @RequestParam(defaultValue="false") boolean availableOnly,
            @RequestParam(defaultValue="0") @Min(0) int page,
            @RequestParam(defaultValue="20") @Min(1) @Max(100) int size) {
        return responses.successPage(service.list(start,end,q,minCapacity,participantCount,
            availableOnly,PageRequest.of(page,size)));
    }
}
