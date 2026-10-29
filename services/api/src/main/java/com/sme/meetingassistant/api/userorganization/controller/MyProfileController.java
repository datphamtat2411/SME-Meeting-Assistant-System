package com.sme.meetingassistant.api.userorganization.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.userorganization.dto.UserDtos;
import com.sme.meetingassistant.api.userorganization.service.UserManagementService;
import com.sme.meetingassistant.api.userorganization.service.UserVersionTags;
import jakarta.validation.Valid;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/** Self-service profile is independent from organization-wide user management. */
@RestController
@RequestMapping("/api/v1/me/profile")
public class MyProfileController {
    private final UserManagementService users;
    private final ApiResponseFactory responses;

    public MyProfileController(UserManagementService users, ApiResponseFactory responses) {
        this.users = users;
        this.responses = responses;
    }

    @GetMapping
    public ResponseEntity<ApiResponse<UserDtos.MyProfile>> get() {
        var actor = users.getMyProfile();
        return ResponseEntity.ok()
            .header(HttpHeaders.ETAG, UserVersionTags.forUser(actor))
            .body(responses.success(UserDtos.MyProfile.of(actor)));
    }

    @PatchMapping
    public ResponseEntity<ApiResponse<UserDtos.MyProfile>> update(
            @RequestHeader(value = HttpHeaders.IF_MATCH, required = false) String ifMatch,
            @Valid @RequestBody UserDtos.UpdateMyProfile payload) {
        var actor = users.updateMyProfile(payload, ifMatch);
        return ResponseEntity.ok()
            .header(HttpHeaders.ETAG, UserVersionTags.forUser(actor))
            .body(responses.success(UserDtos.MyProfile.of(actor)));
    }
}
