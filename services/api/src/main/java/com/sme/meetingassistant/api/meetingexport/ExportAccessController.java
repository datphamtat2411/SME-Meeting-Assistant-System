package com.sme.meetingassistant.api.meetingexport;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import io.swagger.v3.oas.annotations.Operation;
import java.util.UUID;
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

    public ExportAccessController(ExportAccessService access,
            ApiResponseFactory responses) {
        this.access = access;
        this.responses = responses;
    }

    @Operation(summary="Mint a short-lived, currently authorized private export URL",
            description="Only READY artifact. Current meeting-content authorization and "
                + "verified private-object digest required. 30..300s server TTL.")
    @PostMapping("/{exportId}/access-url")
    public ResponseEntity<ApiResponse<ExportAccessService.AccessCapability>> issue(
            @PathVariable UUID exportId) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .header("Pragma", "no-cache")
                .header("Referrer-Policy", "no-referrer")
                .body(responses.success(access.issue(exportId)));
    }
}
