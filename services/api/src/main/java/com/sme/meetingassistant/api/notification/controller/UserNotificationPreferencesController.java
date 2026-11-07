package com.sme.meetingassistant.api.notification.controller;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.notification.preferences.UserNotificationPreferences;
import com.sme.meetingassistant.api.notification.preferences.UserNotificationPreferencesService;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/me/preferences")
public class UserNotificationPreferencesController {
    private final UserNotificationPreferencesService preferences;
    private final ApiResponseFactory responses;

    public UserNotificationPreferencesController(UserNotificationPreferencesService preferences,
            ApiResponseFactory responses) {
        this.preferences = preferences;
        this.responses = responses;
    }

    @GetMapping
    public ResponseEntity<ApiResponse<UserNotificationPreferences>> get() {
        return ResponseEntity.ok(responses.success(preferences.getCurrent()));
    }

    @PatchMapping
    public ResponseEntity<ApiResponse<UserNotificationPreferences>> patch(
            @RequestBody Map<String, Object> payload) {
        return ResponseEntity.ok(responses.success(preferences.patchCurrent(payload)));
    }
}
