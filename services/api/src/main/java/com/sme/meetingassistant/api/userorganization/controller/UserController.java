package com.sme.meetingassistant.api.userorganization.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.userorganization.dto.UserDtos;
import com.sme.meetingassistant.api.userorganization.entity.AccountStatus;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.service.UserManagementService;
import com.sme.meetingassistant.api.userorganization.service.UserVersionTags;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;
import java.net.URI;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

/** Canonical organizational users only. Deactivation/reactivation belongs to T05. */
@Validated
@RestController
@RequestMapping("/api/v1/users")
public class UserController {
    private final UserManagementService users;
    private final ApiResponseFactory responses;

    public UserController(UserManagementService users, ApiResponseFactory responses) {
        this.users = users;
        this.responses = responses;
    }

    @GetMapping
    public ApiResponse<List<UserDtos.UserView>> list(
            @RequestParam(required = false) @Size(max = 200) String q,
            @RequestParam(required = false) GlobalRole role,
            @RequestParam(required = false) AccountStatus status,
            @RequestParam(required = false) UUID orgUnitId,
            @RequestParam(defaultValue = "0") @Min(0) int page,
            @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
        return responses.successPage(users.list(q, role, status, orgUnitId, page, size));
    }

    @PostMapping
    public ResponseEntity<ApiResponse<UserDtos.UserView>> create(@Valid @RequestBody UserDtos.CreateUser payload) {
        var user = users.create(payload);
        return ResponseEntity.created(URI.create("/api/v1/users/" + user.getId()))
            .header(HttpHeaders.ETAG, UserVersionTags.forUser(user))
            .body(responses.success(users.view(user, true)));
    }

    @GetMapping("/{userId}")
    public ResponseEntity<ApiResponse<UserDtos.UserView>> detail(@PathVariable UUID userId) {
        var user = users.getAuthorized(userId);
        return ResponseEntity.ok()
            .header(HttpHeaders.ETAG, UserVersionTags.forUser(user))
            .body(responses.success(users.view(user, true)));
    }

    @PatchMapping("/{userId}")
    public ResponseEntity<ApiResponse<UserDtos.UserView>> update(@PathVariable UUID userId,
            @RequestHeader(value = HttpHeaders.IF_MATCH, required = false) String ifMatch,
            @Valid @RequestBody UserDtos.UpdateUser payload) {
        var user = users.update(userId, payload, ifMatch);
        return ResponseEntity.ok()
            .header(HttpHeaders.ETAG, UserVersionTags.forUser(user))
            .body(responses.success(users.view(user, true)));
    }
}
