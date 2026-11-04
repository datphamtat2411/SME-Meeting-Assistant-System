package com.sme.meetingassistant.api.media.worker;

import com.sme.meetingassistant.api.common.*;
import com.sme.meetingassistant.api.integration.TranscriptionWorkerCompletion;
import com.sme.meetingassistant.api.media.repository.MediaRepository.ProcessingLifecycleConflictException;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.JsonNode;

/** Transport authentication/operation grants are exclusively E2E-01's private boundary. */
@RestController
@RequestMapping("/internal/v1/worker/processing-jobs/{jobId}/transcription")
public class TranscriptionWorkerController {
    private final TranscriptionWorkerService worker;
    private final TranscriptionWorkerCompletion completion;
    private final ApiResponseFactory responses;
    public TranscriptionWorkerController(TranscriptionWorkerService worker,TranscriptionWorkerCompletion completion,ApiResponseFactory responses) {
        this.worker=worker; this.completion=completion; this.responses=responses;
    }
    @PostMapping("/claim")
    public ResponseEntity<ApiResponse<Map<String,Object>>> claim(@PathVariable String jobId,HttpServletRequest request) throws IOException {
        var result=worker.claim(id(jobId),WorkerCommands.claim(body(request)));
        return success(result.containsKey("claimToken")?"WORKER_CLAIMED":"SUCCESS",result);
    }
    @GetMapping("/deliveries/{eventId}")
    public ResponseEntity<ApiResponse<Map<String,Object>>> delivery(@PathVariable String jobId,@PathVariable String eventId,HttpServletRequest request) {
        correlation(request); return success("SUCCESS",worker.status(id(jobId),id(eventId)));
    }
    @PostMapping("/renew")
    public ResponseEntity<ApiResponse<Map<String,Object>>> renew(@PathVariable String jobId,HttpServletRequest request) throws IOException {
        return success("SUCCESS",worker.renew(id(jobId),WorkerCommands.renew(body(request))));
    }
    @PostMapping("/complete")
    public ResponseEntity<ApiResponse<Map<String,Object>>> complete(@PathVariable String jobId,HttpServletRequest request) throws IOException {
        return success("SUCCESS",completion.complete(id(jobId),WorkerCommands.complete(body(request))));
    }
    @PostMapping("/fail")
    public ResponseEntity<ApiResponse<Map<String,Object>>> fail(@PathVariable String jobId,HttpServletRequest request) throws IOException {
        return success("SUCCESS",worker.fail(id(jobId),WorkerCommands.fail(body(request))));
    }
    private ResponseEntity<ApiResponse<Map<String,Object>>> success(String code,Map<String,Object> data) {
        var envelope=responses.success(data);
        return ResponseEntity.ok().header("Cache-Control","no-store").body(new ApiResponse<>(true,code,envelope.message(),data,envelope.meta(),null));
    }
    private static UUID id(String value) {
        return WorkerJson.uuid(WorkerJson.MAPPER.createObjectNode().put("id",value),"id");
    }
    private static void correlation(HttpServletRequest request) {
        String id=request.getHeader("X-Request-Id");
        if(id==null || id.isBlank() || id.length()>128 || id.chars().anyMatch(Character::isISOControl))
            throw new WorkerException(422,"VALIDATION_ERROR");
    }
    private static JsonNode body(HttpServletRequest request) throws IOException {
        correlation(request);
        try {
            var type=MediaType.parseMediaType(request.getContentType()==null?"":request.getContentType());
            if(!MediaType.APPLICATION_JSON.isCompatibleWith(type)
                || type.getCharset()!=null && !type.getCharset().equals(java.nio.charset.StandardCharsets.UTF_8)
                || request.getHeader("Content-Encoding")!=null) throw new WorkerException(415,"UNSUPPORTED_MEDIA_TYPE");
        } catch(org.springframework.http.InvalidMediaTypeException e) { throw new WorkerException(415,"UNSUPPORTED_MEDIA_TYPE"); }
        if(request.getContentLengthLong()>16384) throw new WorkerException(413,"PAYLOAD_TOO_LARGE");
        return WorkerJson.parse(request.getInputStream().readNBytes(16385),16384);
    }
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse<Void>> error(Exception error) {
        int status=503; String code="SERVICE_UNAVAILABLE";
        if(error instanceof WorkerException e) {status=e.status(); code=e.code();}
        else if(error instanceof org.springframework.dao.DuplicateKeyException) {status=409;code="WORKER_COMMAND_CONFLICT";}
        else if(error instanceof ProcessingLifecycleConflictException) {status=409;code="WORKER_LEASE_LOST";}
        else if(error instanceof ResponseStatusException e) {status=e.getStatusCode().value();}
        var response=ResponseEntity.status(status).header("Cache-Control","no-store");
        if(code.equals("WORKER_ATTEMPT_BUSY")) response.header("Retry-After","5");
        return response.body(responses.error(code,"Worker request could not be processed.",null));
    }
}
