package com.sme.meetingassistant.api.meetingminutes;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import io.swagger.v3.oas.annotations.Operation;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** API-EP-EXP-001: consolidated authorized canonical Minutes, no mutations. */
@RestController
@RequestMapping("/api/v1/meetings")
public class MeetingMinutesController {
    private final MinutesAssembler minutes;
    private final ApiResponseFactory responses;

    public MeetingMinutesController(MinutesAssembler minutes, ApiResponseFactory responses) {
        this.minutes = minutes;
        this.responses = responses;
    }

    @Operation(summary = "Get authorized current canonical meeting minutes",
        description = "Official Summary, confirmed Decisions, official Action Items, "
            + "current Transcript reference and quality warnings. "
            + "Unapproved AI proposals excluded until DE-01 D08 approval. "
            + "Snapshot source fingerprint excludes retrieval time.")
    @GetMapping("/{meetingId}/minutes")
    public ResponseEntity<ApiResponse<MinutesSnapshot>> current(
            @PathVariable UUID meetingId) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(responses.success(minutes.current(meetingId)));
    }
}
