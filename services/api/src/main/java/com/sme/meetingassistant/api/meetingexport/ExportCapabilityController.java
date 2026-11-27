package com.sme.meetingassistant.api.meetingexport;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.meeting.service.MeetingMediaAccess;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import io.swagger.v3.oas.annotations.Operation;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Configured endpoint availability, not worker/storage health or admission eligibility. */
@RestController
@RequestMapping("/api/v1/meetings")
public class ExportCapabilityController {
    private final MeetingMediaAccess access;
    private final AuthenticatedUserId actor;
    private final ApiResponseFactory responses;
    private final boolean publicEnabled;
    private final boolean workerEnabled;

    public ExportCapabilityController(MeetingMediaAccess access, AuthenticatedUserId actor,
            ApiResponseFactory responses,
            @Value("${app.exports.public-admission-enabled:false}") boolean publicEnabled,
            @Value("${app.exports.worker.enabled:false}") boolean workerEnabled) {
        this.access = access;
        this.actor = actor;
        this.responses = responses;
        this.publicEnabled = publicEnabled;
        this.workerEnabled = workerEnabled;
    }

    public record Capabilities(UUID meetingId, boolean admission, boolean recovery,
            boolean status, boolean access) { }

    @Operation(summary="Read authorized meeting export endpoint availability")
    @GetMapping("/{meetingId}/exports/capabilities")
    public ResponseEntity<ApiResponse<Capabilities>> get(@PathVariable UUID meetingId) {
        access.requireReadable(meetingId, actor.requireUserId());
        boolean generationEnabled = publicEnabled && workerEnabled;
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(responses.success(new Capabilities(meetingId, generationEnabled,
                        publicEnabled, publicEnabled, generationEnabled)));
    }
}
