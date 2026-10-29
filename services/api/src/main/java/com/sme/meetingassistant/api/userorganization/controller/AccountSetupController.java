package com.sme.meetingassistant.api.userorganization.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/** Single-use initial-credential authorization, separate from public registration. */
@RestController
@RequestMapping("/api/v1/auth/account-setup")
public class AccountSetupController {
    private final AccountSetupService setup;
    private final ApiResponseFactory responses;

    public AccountSetupController(AccountSetupService setup, ApiResponseFactory responses) {
        this.setup = setup;
        this.responses = responses;
    }

    public record CompleteRequest(@NotBlank String token, @NotBlank String password) {}

    @PostMapping
    public ResponseEntity<ApiResponse<Void>> complete(@Valid @RequestBody CompleteRequest payload) {
        setup.completeSetup(payload.token(), payload.password());
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(responses.success(null));
    }
}
