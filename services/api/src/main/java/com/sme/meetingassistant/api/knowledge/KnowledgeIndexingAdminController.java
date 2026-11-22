package com.sme.meetingassistant.api.knowledge;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.userorganization.service.OrganizationalAuthorizationService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import java.util.Map;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Administrator-only repair and generation controls; no browser can submit worker claims. */
@Validated
@RestController
@RequestMapping("/api/v1/admin/knowledge")
@ConditionalOnProperty(prefix = "app.media.knowledge-indexing", name = "enabled", havingValue = "true")
public class KnowledgeIndexingAdminController {
    private final KnowledgeIndexingAdminService service;
    private final OrganizationalAuthorizationService authorization;
    private final ApiResponseFactory responses;

    public KnowledgeIndexingAdminController(KnowledgeIndexingAdminService service,
            OrganizationalAuthorizationService authorization, ApiResponseFactory responses) {
        this.service = service;
        this.authorization = authorization;
        this.responses = responses;
    }

    @PostMapping("/reindex")
    public ResponseEntity<ApiResponse<Map<String, Object>>> reindex(@Valid @RequestBody RepairRequest request) {
        var actor = authorization.requireAdministrator();
        return ok(service.reindex(request.sourceType(), request.sourceId(), request.meetingId(),
            request.generationId(), actor.getId()));
    }

    @PostMapping("/delete")
    public ResponseEntity<ApiResponse<Map<String, Object>>> delete(@Valid @RequestBody DeleteRequest request) {
        var actor = authorization.requireAdministrator();
        return ok(service.delete(request.sourceType(), request.sourceId(), request.meetingId(), actor.getId()));
    }

    @GetMapping("/generations/{generationId}")
    public ResponseEntity<ApiResponse<Map<String, Object>>> generation(@PathVariable String generationId) {
        authorization.requireAdministrator();
        return ok(service.generation(generationId));
    }

    @PostMapping("/generations/prepare")
    public ResponseEntity<ApiResponse<Map<String, Object>>> prepare(
            @Valid @RequestBody GenerationPrepareRequest request) {
        authorization.requireAdministrator();
        return ok(service.prepare(request.generationId(), request.configurationVersion(),
            request.configurationSha256(), request.tokenizerId(), request.collectionName()));
    }

    @PostMapping("/generations/{generationId}/refresh")
    public ResponseEntity<ApiResponse<Map<String, Object>>> refresh(@PathVariable String generationId) {
        authorization.requireAdministrator();
        return ok(service.refresh(generationId));
    }

    @PostMapping("/generations/{generationId}/activate")
    public ResponseEntity<ApiResponse<Map<String, Object>>> activate(@PathVariable String generationId) {
        authorization.requireAdministrator();
        return ok(service.activate(generationId));
    }

    @PostMapping("/generations/{generationId}/seal")
    public ResponseEntity<ApiResponse<Map<String, Object>>> seal(@PathVariable String generationId) {
        authorization.requireAdministrator();
        return ok(service.seal(generationId));
    }

    @PostMapping("/generations/{generationId}/unseal")
    public ResponseEntity<ApiResponse<Map<String, Object>>> unseal(@PathVariable String generationId) {
        authorization.requireAdministrator();
        return ok(service.unseal(generationId));
    }

    @PostMapping("/reconciliation")
    public ResponseEntity<ApiResponse<Map<String, Object>>> reconcile(
            @Valid @RequestBody ReconciliationRequest request) {
        var actor = authorization.requireAdministrator();
        return ok(service.startReconciliation(request.generationId(), request.batchSize(), request.dryRun(),
            request.certificationMode(), actor.getId()));
    }

    @GetMapping("/reconciliation/{runId}")
    public ResponseEntity<ApiResponse<Map<String, Object>>> reconciliation(@PathVariable UUID runId) {
        authorization.requireAdministrator();
        return ok(service.reconciliation(runId));
    }

    @PostMapping("/reconciliation/{runId}/resume")
    public ResponseEntity<ApiResponse<Map<String, Object>>> resume(@PathVariable UUID runId) {
        var actor = authorization.requireAdministrator();
        return ok(service.resumeReconciliation(runId, actor.getId()));
    }

    private ResponseEntity<ApiResponse<Map<String, Object>>> ok(Map<String, Object> data) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(responses.success(data));
    }

    public record RepairRequest(
            @NotBlank @Pattern(regexp = "TRANSCRIPT|SUMMARY|DECISION|ACTION_ITEM") String sourceType,
            @NotNull UUID sourceId, @NotNull UUID meetingId,
            @NotBlank @Pattern(regexp = "[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}") String generationId) { }

    public record GenerationPrepareRequest(
            @NotBlank @Pattern(regexp = "[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}") String generationId,
            @NotBlank @Pattern(regexp = "[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}") String configurationVersion,
            @NotBlank @Pattern(regexp = "[a-f0-9]{64}") String configurationSha256,
            @NotBlank @Pattern(regexp = "[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}") String tokenizerId,
            @NotBlank @Pattern(regexp = "[A-Za-z0-9][A-Za-z0-9_.-]{0,126}") String collectionName) { }

    public record DeleteRequest(
            @NotBlank @Pattern(regexp = "TRANSCRIPT|SUMMARY|DECISION|ACTION_ITEM") String sourceType,
            @NotNull UUID sourceId, @NotNull UUID meetingId) { }

    public record ReconciliationRequest(
            @NotBlank @Pattern(regexp = "[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}") String generationId,
            @Min(1) @Max(500) int batchSize, boolean dryRun,
            @Pattern(regexp = "OPERATIONAL|CERTIFICATION") String certificationMode) { }
}
