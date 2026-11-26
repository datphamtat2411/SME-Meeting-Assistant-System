package com.sme.meetingassistant.api.meetingexport;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import io.swagger.v3.oas.annotations.Operation;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import java.time.OffsetDateTime;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Replay-only admission lookup. A distinct route prevents an older server from
 * interpreting a recovery request as normal create-or-replay admission.
 */
@RestController
@RequestMapping("/api/v1/meetings")
@ConditionalOnProperty(name="app.exports.public-admission-enabled", havingValue="true")
public class ExportRecoveryController {
    private final ExportSubmissionService submission;
    private final ApiResponseFactory responses;

    public ExportRecoveryController(ExportSubmissionService submission, ApiResponseFactory responses) {
        this.submission = submission;
        this.responses = responses;
    }

    public record Request(@NotNull ExportFormat format) { }
    public record Admission(UUID exportId, UUID meetingId, ExportFormat format,
            ExportStatus status, OffsetDateTime createdAt) { }
    public enum Outcome { RECOVERED, UNAVAILABLE }
    public record RecoveryView(Outcome outcome, Admission admission) { }

    @Operation(summary="Recover an existing export admission without creating a new export")
    @PostMapping("/{meetingId}/exports/recover")
    public ResponseEntity<ApiResponse<RecoveryView>> recover(@PathVariable UUID meetingId,
            @Valid @RequestBody Request request,
            @RequestHeader("Idempotency-Key") String idempotencyKey) {
        var record = submission.recover(meetingId, request.format(), idempotencyKey);
        var result = record.map(value -> new RecoveryView(Outcome.RECOVERED,
                new Admission(value.id(), value.meetingId(), value.format(),
                        value.status(), value.createdAt())))
                .orElseGet(() -> new RecoveryView(Outcome.UNAVAILABLE, null));
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(responses.success(result));
    }
}
