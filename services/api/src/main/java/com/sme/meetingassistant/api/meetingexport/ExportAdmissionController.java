package com.sme.meetingassistant.api.meetingexport;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.meetingminutes.MinutesAssembler;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import java.time.OffsetDateTime;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import io.swagger.v3.oas.annotations.Operation;

/**
 * Public creation stays opt-in until DE01 D09/D10/D12 product review.
 * Conservative policy: no incomplete or unreviewed minutes may be exported.
 */
@RestController
@RequestMapping("/api/v1/meetings")
@ConditionalOnProperty(name="app.exports.public-admission-enabled", havingValue="true")
public class ExportAdmissionController {
    private final MinutesAssembler minutes;
    private final ExportSubmissionService submission;
    private final ApiResponseFactory responses;

    public ExportAdmissionController(MinutesAssembler minutes,
            ExportSubmissionService submission, ApiResponseFactory responses) {
        this.minutes = minutes;
        this.submission = submission;
        this.responses = responses;
    }

    public record Request(@NotNull ExportFormat format) { }
    public record Accepted(UUID exportId, UUID meetingId, ExportFormat format,
            ExportStatus status, OffsetDateTime createdAt) { }

    @Operation(summary="Admit a durable, authorized complete-minutes export",
        description="Feature gated pending D09/D10/D12 policy review. "
            + "Only COMPLETE snapshots, official decisions/actions, no proposals.")
    @PostMapping("/{meetingId}/exports")
    public ResponseEntity<ApiResponse<Accepted>> create(@PathVariable UUID meetingId,
            @Valid @RequestBody Request request,
            @RequestHeader("Idempotency-Key") String idempotencyKey) {
        var snapshot = minutes.current(meetingId);
        if (!"COMPLETE".equals(snapshot.completeness()) || snapshot.proposalsIncluded()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Minutes have outstanding completeness or review warnings");
        }
        var record = submission.submit(meetingId, request.format(), idempotencyKey, snapshot);
        return ResponseEntity.status(HttpStatus.ACCEPTED)
                .cacheControl(CacheControl.noStore())
                .body(responses.success("Export intent durably accepted.",
                        new Accepted(record.id(), record.meetingId(),
                                record.format(), record.status(), record.createdAt())));
    }
}
