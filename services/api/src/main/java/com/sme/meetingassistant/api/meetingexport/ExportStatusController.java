package com.sme.meetingassistant.api.meetingexport;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.meeting.service.MeetingMediaAccess;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import java.time.OffsetDateTime;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import io.swagger.v3.oas.annotations.Operation;

/** Never serialize internal S3 keys, worker claims or signed URLs. */
@RestController
@RequestMapping("/api/v1/exports")
@ConditionalOnProperty(name="app.exports.public-admission-enabled", havingValue="true")
public class ExportStatusController {
    private final MeetingExportRepository records;
    private final MeetingMediaAccess access;
    private final AuthenticatedUserId actor;
    private final ApiResponseFactory responses;
    private final ExportFreshnessService freshness;

    public ExportStatusController(MeetingExportRepository records,
            MeetingMediaAccess access, AuthenticatedUserId actor,
            ApiResponseFactory responses, ExportFreshnessService freshness) {
        this.records = records;
        this.access = access;
        this.actor = actor;
        this.responses = responses;
        this.freshness = freshness;
    }

    public record StatusView(UUID exportId, UUID meetingId, ExportFormat format,
            ExportStatus status, int attemptCount, OffsetDateTime createdAt,
            OffsetDateTime readyAt, String safeErrorCode,
            ExportFreshnessService.Freshness freshness,
            OffsetDateTime freshnessCheckedAt) { }

    @Operation(summary="Read current authorized status of a durable export")
    @GetMapping("/{exportId}")
    public ResponseEntity<ApiResponse<StatusView>> get(@PathVariable UUID exportId) {
        ExportRecord record = records.require(exportId);
        access.requireReadable(record.meetingId(), actor.requireUserId());
        var evidence = freshness.evaluate(record);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(responses.success(new StatusView(record.id(),record.meetingId(),
                        record.format(),record.status(),record.generationAttempt(),
                        record.createdAt(),record.readyAt(),record.lastErrorCode(),
                        evidence.freshness(),evidence.checkedAt())));
    }
}
