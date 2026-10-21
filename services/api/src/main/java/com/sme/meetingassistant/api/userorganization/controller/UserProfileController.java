package com.sme.meetingassistant.api.userorganization.controller;
import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.userorganization.dto.OrganizationDtos;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import com.sme.meetingassistant.api.userorganization.service.UserProfileService;
import jakarta.validation.Valid;
import java.security.Principal;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/v1/users/me")
public class UserProfileController {
    private final UserProfileService service;private final AuthenticatedUserId caller;private final ApiResponseFactory responses;
    public UserProfileController(UserProfileService service,AuthenticatedUserId caller,ApiResponseFactory responses){this.service=service;this.caller=caller;this.responses=responses;}
    @GetMapping public ApiResponse<OrganizationDtos.UserProfile> get(Principal principal){return responses.success(service.get(caller.from(principal)));}
    @PatchMapping public ApiResponse<OrganizationDtos.UserProfile> update(@Valid @RequestBody OrganizationDtos.UpdateProfile request,Principal principal){return responses.success(service.update(caller.from(principal),request));}
}
