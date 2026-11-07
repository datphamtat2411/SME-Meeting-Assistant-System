package com.sme.meetingassistant.api.media.diarization;

import com.sme.meetingassistant.api.common.*;
import com.sme.meetingassistant.api.media.repository.MediaRepository.ProcessingLifecycleConflictException;
import com.sme.meetingassistant.api.media.worker.*;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import tools.jackson.databind.JsonNode;

/** The private connector and operation-grant chain authenticate before invoking this adapter. */
@RestController
@RequestMapping("/internal/v1/worker/processing-jobs/{jobId}/diarization")
public class DiarizationWorkerController {
    private final DiarizationWorkerService worker;
    private final DiarizationCompletion completion;
    private final ApiResponseFactory responses;
    public DiarizationWorkerController(DiarizationWorkerService worker,DiarizationCompletion completion,ApiResponseFactory responses) {
        this.worker=worker;this.completion=completion;this.responses=responses;
    }
    @PostMapping("/claim")
    public ResponseEntity<ApiResponse<Object>> claim(@PathVariable String jobId,HttpServletRequest request) throws IOException {
        return success(worker.claim(id(jobId),DiarizationCommands.claim(body(request))));
    }
    @PostMapping("/snapshot")
    public ResponseEntity<ApiResponse<Object>> snapshot(@PathVariable String jobId,HttpServletRequest request) throws IOException {
        return success(worker.snapshot(id(jobId),DiarizationCommands.owner(body(request))));
    }
    @PostMapping("/renew")
    public ResponseEntity<ApiResponse<Object>> renew(@PathVariable String jobId,HttpServletRequest request) throws IOException {
        return success(worker.renew(id(jobId),DiarizationCommands.owner(body(request))));
    }
    @PostMapping("/complete")
    public ResponseEntity<ApiResponse<Object>> complete(@PathVariable String jobId,HttpServletRequest request) throws IOException {
        return success(completion.complete(id(jobId),DiarizationCommands.complete(body(request))));
    }
    @PostMapping("/fail")
    public ResponseEntity<ApiResponse<Object>> fail(@PathVariable String jobId,HttpServletRequest request) throws IOException {
        return success(worker.fail(id(jobId),DiarizationCommands.fail(body(request))));
    }
    @GetMapping("/deliveries/{eventId}")
    public ResponseEntity<ApiResponse<Object>> delivery(@PathVariable String jobId,@PathVariable String eventId,HttpServletRequest request) {
        correlation(request);return success(worker.status(id(jobId),id(eventId)));
    }
    private ResponseEntity<ApiResponse<Object>> success(Object data) {
        return ResponseEntity.ok().header("Cache-Control","no-store").body(responses.success(data));
    }
    private static UUID id(String value) {return WorkerJson.uuid(WorkerJson.MAPPER.createObjectNode().put("id",value),"id");}
    private static void correlation(HttpServletRequest request) {
        String id=request.getHeader("X-Request-Id");
        if(id==null || id.isBlank() || id.length()>128 || id.chars().anyMatch(Character::isISOControl)) throw new WorkerException(422,"VALIDATION_ERROR");
    }
    private static JsonNode body(HttpServletRequest request) throws IOException {
        correlation(request);
        try {
            var type=MediaType.parseMediaType(request.getContentType()==null?"":request.getContentType());
            if(!MediaType.APPLICATION_JSON.isCompatibleWith(type) || type.getCharset()!=null && !StandardCharsets.UTF_8.equals(type.getCharset())
                || request.getHeader("Content-Encoding")!=null) throw new WorkerException(415,"UNSUPPORTED_MEDIA_TYPE");
        } catch(InvalidMediaTypeException invalid) {throw new WorkerException(415,"UNSUPPORTED_MEDIA_TYPE");}
        if(request.getContentLengthLong()>16384) throw new WorkerException(413,"PAYLOAD_TOO_LARGE");
        return WorkerJson.parse(request.getInputStream().readNBytes(16385),16384);
    }
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse<Void>> error(Exception error) {
        int status=503;String code="SERVICE_UNAVAILABLE";
        if(error instanceof WorkerException e) {status=e.status();code=e.code();}
        else if(error instanceof org.springframework.dao.DuplicateKeyException) {status=409;code="WORKER_COMMAND_CONFLICT";}
        else if(error instanceof ProcessingLifecycleConflictException) {status=409;code="WORKER_LEASE_LOST";}
        var response=ResponseEntity.status(status).header("Cache-Control","no-store");
        if("WORKER_ATTEMPT_BUSY".equals(code)) response.header("Retry-After","5");
        return response.body(responses.error(code,"Worker request could not be processed.",null));
    }
}
