package com.sme.meetingassistant.api.dashboard.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.dashboard.dto.PersonalDashboardView;
import com.sme.meetingassistant.api.dashboard.service.PersonalDashboardService;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import io.swagger.v3.oas.annotations.Operation;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** API-EP-DASH-001: read-only personal dashboard within current user scope. */
@RestController
@Validated
@RequestMapping("/api/v1/dashboard")
public class PersonalDashboardController {
    private final PersonalDashboardService service;
    private final ApiResponseFactory responses;
    private final AuthenticatedUserId caller;

    public PersonalDashboardController(PersonalDashboardService service,
            ApiResponseFactory responses, AuthenticatedUserId caller) {
        this.service = service;
        this.responses = responses;
        this.caller = caller;
    }

    @Operation(summary = "Retrieve current user's personal dashboard",
            description = "Current authorized meeting overview and official assigned Action Item metrics. "
                    + "Technical defaults: upcomingDays=14, recentDays=30, limit=10; "
                    + "product window policy is pending DE-01 D07 approval.")
    @GetMapping("/me")
    public ResponseEntity<ApiResponse<PersonalDashboardView>> me(
            @RequestParam(defaultValue = "14") @Min(1) @Max(90) int upcomingDays,
            @RequestParam(defaultValue = "30") @Min(1) @Max(90) int recentDays,
            @RequestParam(defaultValue = "10") @Min(1) @Max(50) int limit) {
        var actorId = caller.requireUserId();
        PersonalDashboardView dashboard = service.get(actorId, upcomingDays, recentDays, limit);
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(responses.success(dashboard));
    }
}
