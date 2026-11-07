package com.sme.meetingassistant.api.dashboard.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.dashboard.dto.ManagementDashboardView;
import com.sme.meetingassistant.api.dashboard.service.ManagementDashboardService;
import io.swagger.v3.oas.annotations.Operation;
import java.time.OffsetDateTime;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** API-EP-DASH-002 — source-scoped, read-only management reporting. */
@RestController
@RequestMapping("/api/v1/dashboard")
public class ManagementDashboardController {
    private final ManagementDashboardService service;
    private final ApiResponseFactory responses;

    public ManagementDashboardController(ManagementDashboardService service,
            ApiResponseFactory responses) {
        this.service = service;
        this.responses = responses;
    }

    @Operation(summary = "Get authorized management Action Item metrics",
            description = "Official Action Item current-state counts for a Department "
                    + "Manager's active, recorded Action Item scope and an explicit "
                    + "[from,to) creation-time cohort. Unapproved meeting, AI and "
                    + "percentage metrics are marked unavailable, not fabricated.")
    @GetMapping("/management")
    public ResponseEntity<ApiResponse<ManagementDashboardView>> management(
            @RequestParam OffsetDateTime from,
            @RequestParam OffsetDateTime to,
            @RequestParam(required = false) UUID orgUnitId) {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(responses.success(service.get(from, to, orgUnitId)));
    }
}
