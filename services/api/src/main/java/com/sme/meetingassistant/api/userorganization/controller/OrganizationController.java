package com.sme.meetingassistant.api.userorganization.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.userorganization.dto.OrganizationDtos;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import com.sme.meetingassistant.api.userorganization.service.OrganizationService;
import jakarta.validation.Valid;
import java.security.Principal;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/organizations")
public class OrganizationController {
    private final OrganizationService service; private final AuthenticatedUserId caller; private final ApiResponseFactory responses;
    public OrganizationController(OrganizationService service,AuthenticatedUserId caller,ApiResponseFactory responses){this.service=service;this.caller=caller;this.responses=responses;}
    @PostMapping @ResponseStatus(HttpStatus.CREATED)
    public ApiResponse<OrganizationDtos.Organization> create(@Valid @RequestBody OrganizationDtos.Create request,Principal principal){return responses.success(service.create(caller.from(principal),request));}
    @GetMapping public ApiResponse<List<OrganizationDtos.Organization>> list(Principal principal){return responses.success(service.list(caller.from(principal)));}
    @GetMapping("/{organizationId}") public ApiResponse<OrganizationDtos.Organization> get(@PathVariable UUID organizationId,Principal principal){return responses.success(service.get(organizationId,caller.from(principal)));}
    @PatchMapping("/{organizationId}") public ApiResponse<OrganizationDtos.Organization> update(@PathVariable UUID organizationId,@Valid @RequestBody OrganizationDtos.Update request,Principal principal){return responses.success(service.update(organizationId,caller.from(principal),request));}
    @GetMapping("/{organizationId}/members") public ApiResponse<List<OrganizationDtos.Member>> members(@PathVariable UUID organizationId,Principal principal){return responses.success(service.members(organizationId,caller.from(principal)));}
    @PostMapping("/{organizationId}/members") @ResponseStatus(HttpStatus.CREATED)
    public ApiResponse<OrganizationDtos.Member> addMember(@PathVariable UUID organizationId,@Valid @RequestBody OrganizationDtos.AddMember request,Principal principal){return responses.success(service.addMember(organizationId,caller.from(principal),request));}
    @DeleteMapping("/{organizationId}/members/{userId}") @ResponseStatus(HttpStatus.NO_CONTENT)
    public void removeMember(@PathVariable UUID organizationId,@PathVariable UUID userId,Principal principal){service.removeMember(organizationId,userId,caller.from(principal));}
}
