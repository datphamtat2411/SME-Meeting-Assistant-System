package com.sme.meetingassistant.api.authentication.controller;

import com.sme.meetingassistant.api.authentication.dto.AuthRequests;
import com.sme.meetingassistant.api.authentication.service.AuthenticationService;
import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/auth")
public class AuthenticationController {
    private final AuthenticationService service;
    private final ApiResponseFactory responses;
    public AuthenticationController(AuthenticationService service, ApiResponseFactory responses) { this.service = service; this.responses = responses; }
    @PostMapping("/register") @ResponseStatus(HttpStatus.CREATED)
    public ApiResponse<AuthRequests.Tokens> register(@Valid @RequestBody AuthRequests.Register request) { return responses.success(service.register(request)); }
    @PostMapping("/login")
    public ApiResponse<AuthRequests.Tokens> login(@Valid @RequestBody AuthRequests.Login request) { return responses.success(service.login(request)); }
    @PostMapping("/refresh")
    public ApiResponse<AuthRequests.Tokens> refresh(@Valid @RequestBody AuthRequests.Refresh request) { return responses.success(service.refresh(request.refreshToken())); }
    @PostMapping("/logout")
    public ApiResponse<Void> logout(@Valid @RequestBody AuthRequests.Logout request) { service.logout(request.refreshToken()); return responses.success(null); }
}
