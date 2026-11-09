package com.sme.meetingassistant.api.meetingintelligence.internal;

import com.sme.meetingassistant.api.common.*;
import com.sme.meetingassistant.api.media.repository.MediaRepository.ProcessingLifecycleConflictException;
import com.sme.meetingassistant.api.media.worker.*;
import com.sme.meetingassistant.api.meetingintelligence.service.ActionItemWorkerAcceptance;
import com.sme.meetingassistant.api.transport.PrivateConnector;
import jakarta.servlet.http.HttpServletRequest;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/** Private connector + separate canonical bearer are checked before bounded parsing. */
@RestController
@RequestMapping("/internal/api/v1/meeting-intelligence/action-items")
@ConditionalOnProperty(prefix="app.mi.internal-result",name="enabled",havingValue="true")
public class InternalActionItemController {
    private static final int MAX_BYTES=4*1024*1024;
    private final ActionItemWorkerAcceptance acceptance;
    private final ApiResponseFactory responses;
    public InternalActionItemController(ActionItemWorkerAcceptance acceptance,ApiResponseFactory responses) {
        this.acceptance=acceptance;this.responses=responses;
    }
    public record Accepted(String contractVersion,UUID eventId,UUID stageRunId,UUID sourceSnapshotId,
            boolean replay,int newProposals) {}
    @PostMapping("/accept")
    public ResponseEntity<ApiResponse<Accepted>> accept(HttpServletRequest request) throws java.io.IOException {
        String peer=PrivateConnector.actionItemWorkerCertificateFingerprint(request);
        String correlation=request.getHeader("X-Request-Id");
        WorkerJson.require(correlation!=null && !correlation.isBlank() && correlation.length()<=128
            && correlation.chars().noneMatch(Character::isISOControl));
        try {
            var type=MediaType.parseMediaType(request.getContentType()==null?"":request.getContentType());
            if(!MediaType.APPLICATION_JSON.isCompatibleWith(type) || type.getCharset()!=null
                    && !StandardCharsets.UTF_8.equals(type.getCharset()) || request.getHeader("Content-Encoding")!=null)
                throw new WorkerException(415,"UNSUPPORTED_MEDIA_TYPE");
        } catch(InvalidMediaTypeException invalid) {throw new WorkerException(415,"UNSUPPORTED_MEDIA_TYPE");}
        if(request.getContentLengthLong()>MAX_BYTES) throw new WorkerException(413,"PAYLOAD_TOO_LARGE");
        var input=ActionItemAcceptanceRequest.parse(WorkerJson.parse(request.getInputStream().readNBytes(MAX_BYTES+1),MAX_BYTES));
        var receipt=acceptance.accept(input.eventId(),input.claim(),input.source(),input.candidates(),peer);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(responses.success(new Accepted("1.0",
            input.eventId(),input.claim().stageRunId(),input.source().snapshotId(),receipt.replay(),receipt.newProposals())));
    }
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse<Void>> error(Exception error) {
        int status=503;String code="SERVICE_UNAVAILABLE";
        if(error instanceof WorkerException e) {status=e.status();code=e.code();}
        else if(error instanceof ProcessingLifecycleConflictException) {status=409;code="WORKER_LEASE_LOST";}
        else if(error instanceof IllegalArgumentException) {status=422;code="VALIDATION_ERROR";}
        else if(error instanceof org.springframework.dao.InvalidDataAccessApiUsageException
                && error.getCause() instanceof IllegalArgumentException) {status=422;code="VALIDATION_ERROR";}
        else if(error instanceof SecurityException) {status=403;code="AUTHZ_FORBIDDEN";}
        else if(error instanceof ResponseStatusException e) {status=e.getStatusCode().value();}
        return ResponseEntity.status(status).cacheControl(CacheControl.noStore())
            .body(responses.error(code,"Action Item acceptance could not be processed.",null));
    }
}
