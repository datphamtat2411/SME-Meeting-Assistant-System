package com.sme.meetingassistant.api.meetingintelligence.internal;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.media.repository.MediaRepository.ProcessingLifecycleConflictException;
import com.sme.meetingassistant.api.media.service.ProcessingJobLifecycle.StageClaim;
import com.sme.meetingassistant.api.meetingintelligence.service.IntelligenceResultIngestion;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.dao.DataAccessException;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * API-owned bounded ingress. Authentication is enforced before MVC by the
 * dedicated internal security chain. No caller-provided job, meeting, actor,
 * source, stage outcome, or artifact URL is accepted.
 */
@RestController
@RequestMapping("/internal/api/v1/meeting-intelligence/results")
@ConditionalOnProperty(prefix="app.mi.internal-result",name="enabled",havingValue="true")
public class InternalResultController {
    private final IntelligenceResultIngestion ingestion;
    private final ApiResponseFactory responses;

    public InternalResultController(IntelligenceResultIngestion ingestion,
            ApiResponseFactory responses) {
        this.ingestion=ingestion;
        this.responses=responses;
    }

    public record AcceptRequest(@NotNull UUID stageRunId,
            @NotNull UUID claimToken,
            @NotNull @Pattern(regexp="[0-9a-f]{64}") String artifactSha256) { }
    public record AcceptedResult(boolean replay,int writtenRows) { }

    @PostMapping("/accept")
    public ResponseEntity<ApiResponse<AcceptedResult>> accept(
            @Valid @RequestBody AcceptRequest input) {
        try {
            var receipt=ingestion.ingest(
                new StageClaim(input.stageRunId(),input.claimToken()),input.artifactSha256());
            return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(responses.success("Result acceptance completed.",
                    new AcceptedResult(receipt.replay(),receipt.writtenRows())));
        } catch(ProcessingLifecycleConflictException conflict) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "Stage claim is no longer eligible.",conflict);
        } catch(IllegalArgumentException invalid) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                "Result contract or source evidence was rejected.",invalid);
        } catch(IllegalStateException | DataAccessException unavailable) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "Result acceptance is temporarily unavailable.",unavailable);
        }
    }
}
