package com.sme.meetingassistant.api.authentication.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public final class AuthRequests {
    private AuthRequests() { }
    public record Register(@NotBlank @Email @Size(max = 320) String email,
            @NotBlank @Size(min = 12, max = 72) String password,
            @NotBlank @Size(max = 120) String displayName) { }
    public record Login(@NotBlank @Email @Size(max = 320) String email, @NotBlank String password) { }
    public record Refresh(@NotBlank @Size(max = 128) String refreshToken) { }
    public record Logout(@NotBlank @Size(max = 128) String refreshToken) { }
    public record Tokens(String accessToken, String tokenType, long expiresInSeconds, String refreshToken,
            String userId, String email) { }
}
