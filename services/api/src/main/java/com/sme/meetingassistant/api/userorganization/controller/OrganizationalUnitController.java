package com.sme.meetingassistant.api.userorganization.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.userorganization.service.OrganizationalUnitDirectoryService;
import com.sme.meetingassistant.api.userorganization.service.OrganizationalUnitDirectoryService.OrganizationalUnitItem;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import java.util.List;
import org.springframework.data.domain.Page;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** API-EP-USER-007: read-only organizational directory scoped to the authenticated actor. */
@Validated
@RestController
@RequestMapping("/api/v1/organizational-units")
public class OrganizationalUnitController {
    private final OrganizationalUnitDirectoryService directory;
    private final ApiResponseFactory responses;

    public OrganizationalUnitController(OrganizationalUnitDirectoryService directory,
            ApiResponseFactory responses) {
        this.directory = directory;
        this.responses = responses;
    }

    @GetMapping
    public ApiResponse<List<OrganizationalUnitItem>> list(
            @RequestParam(defaultValue = "0") @Min(0) int page,
            @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
        Page<OrganizationalUnitItem> authorizedPage = directory.listAuthorizedActiveUnits(page, size);
        return responses.successPage(authorizedPage);
    }
}
