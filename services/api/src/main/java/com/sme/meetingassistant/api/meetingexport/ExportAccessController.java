package com.sme.meetingassistant.api.meetingexport;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import io.swagger.v3.oas.annotations.Operation;
import java.util.UUID;
import java.time.OffsetDateTime;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * RE02 API-EP-EXP-004. No client-provided filename, key or TTL and no proxy
 * download that could bypass current meeting-content authorization.
 */
@RestController
@RequestMapping("/api/v1/exports")
@ConditionalOnProperty(name={"app.exports.public-admission-enabled",
        "app.exports.worker.enabled"}, havingValue="true")
public class ExportAccessController {
    private final ExportAccessService access;
    private final ApiResponseFactory responses;
    private final MeetingExportRepository records;
    private final ExportFreshnessService freshness;

    public ExportAccessController(ExportAccessService access,
            ApiResponseFactory responses, MeetingExportRepository records,
            ExportFreshnessService freshness) {
        this.access = access;
        this.responses = responses;
        this.records = records;
        this.freshness = freshness;
    }

    public record AccessView(UUID exportId, String accessUrl, String filename,
            String contentType, OffsetDateTime expiresAt,
            ExportFreshnessService.Freshness freshness,
            OffsetDateTime freshnessCheckedAt) { }

    @Operation(summary="Mint a short-lived, currently authorized private export URL",
            description="Only READY artifact. Current meeting-content authorization and "
                + "verified private-object digest required. 30..300s server TTL.")
    @PostMapping("/{exportId}/access-url")
    public ResponseEntity<ApiResponse<AccessView>> issue(
            @PathVariable UUID exportId) {
        // DE-10 performs permission checks before/after S3 verification;
        // DE-11 makes a second independently authorized canonical read before
        // the response is sent, so historical bytes are never labeled current
        // merely because their immutable READY metadata is intact.
        var capability = access.issue(exportId);
        var evidence = freshness.evaluate(records.require(exportId));
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .header("Pragma", "no-cache")
                .header("Referrer-Policy", "no-referrer")
                .body(responses.success(new AccessView(capability.exportId(),
                        capability.accessUrl(), capability.filename(), capability.contentType(),
                        capability.expiresAt(), evidence.freshness(), evidence.checkedAt())));
    }
}
