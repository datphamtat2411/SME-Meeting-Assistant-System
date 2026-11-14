package com.sme.meetingassistant.api.knowledge;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import com.sme.meetingassistant.api.transport.PrivateConnector;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.CacheControl;
import org.springframework.http.InvalidMediaTypeException;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

/** Private mTLS worker boundary; no public JWT or browser session is accepted. */
@RestController
@RequestMapping("/internal/v1/worker/knowledge-indexing/deliveries/{eventId}")
@ConditionalOnProperty(prefix = "app.media.knowledge-indexing", name = "enabled", havingValue = "true")
public class KnowledgeIndexingWorkerController {
    private static final int MAX_COMMAND_BYTES = 16 * 1024;
    private final KnowledgeIndexingWorkerService worker;
    private final ApiResponseFactory responses;

    public KnowledgeIndexingWorkerController(KnowledgeIndexingWorkerService worker,
            ApiResponseFactory responses) {
        this.worker = worker;
        this.responses = responses;
    }

    @GetMapping
    public ResponseEntity<ApiResponse<Map<String, Object>>> status(@PathVariable String eventId,
            HttpServletRequest request) {
        correlation(request);
        return success(worker.status(id(eventId)));
    }

    @PostMapping("/claim")
    public ResponseEntity<ApiResponse<Map<String, Object>>> claim(@PathVariable String eventId,
            HttpServletRequest request) throws IOException {
        UUID path = id(eventId);
        KnowledgeIndexingWorkerCommands.Claim command =
            KnowledgeIndexingWorkerCommands.claim(body(request));
        KnowledgeIndexingWorkerCommands.requireEvent(path, command.eventId());
        return success(worker.claim(path, command, PrivateConnector.workerCertificateFingerprint(request)));
    }

    @PostMapping("/renew")
    public ResponseEntity<ApiResponse<Map<String, Object>>> renew(@PathVariable String eventId,
            HttpServletRequest request) throws IOException {
        UUID path = id(eventId);
        var command = KnowledgeIndexingWorkerCommands.owner(body(request));
        KnowledgeIndexingWorkerCommands.requireEvent(path, command.eventId());
        return success(worker.renew(path, command, PrivateConnector.workerCertificateFingerprint(request)));
    }

    @PostMapping("/snapshot")
    public ResponseEntity<byte[]> snapshot(@PathVariable String eventId, HttpServletRequest request)
            throws IOException {
        UUID path = id(eventId);
        var command = KnowledgeIndexingWorkerCommands.owner(body(request));
        KnowledgeIndexingWorkerCommands.requireEvent(path, command.eventId());
        var snapshot = worker.snapshot(path, command, PrivateConnector.workerCertificateFingerprint(request));
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .contentType(MediaType.APPLICATION_JSON)
            .contentLength(snapshot.sizeBytes())
            .header("X-Snapshot-Id", snapshot.snapshotId().toString())
            .header("X-Snapshot-Sha256", snapshot.sha256())
            .body(snapshot.bytes());
    }

    @PostMapping("/result")
    public ResponseEntity<ApiResponse<Map<String, Object>>> result(@PathVariable String eventId,
            HttpServletRequest request) throws IOException {
        UUID path = id(eventId);
        var command = KnowledgeIndexingWorkerCommands.result(body(request));
        KnowledgeIndexingWorkerCommands.requireEvent(path, command.eventId());
        return success(worker.result(path, command, PrivateConnector.workerCertificateFingerprint(request)));
    }

    @PostMapping("/permit")
    public ResponseEntity<ApiResponse<Map<String, Object>>> permit(@PathVariable String eventId,
            HttpServletRequest request) throws IOException {
        UUID path = id(eventId);
        var command = KnowledgeIndexingWorkerCommands.permitAcquire(body(request));
        KnowledgeIndexingWorkerCommands.requireEvent(path, command.eventId());
        return success(worker.acquirePermit(path, command,
            PrivateConnector.workerCertificateFingerprint(request)));
    }

    @PostMapping("/permit/{permitId}/start")
    public ResponseEntity<ApiResponse<Map<String, Object>>> startPermit(@PathVariable String eventId,
            @PathVariable String permitId, HttpServletRequest request) throws IOException {
        UUID path = id(eventId);
        UUID permit = id(permitId);
        var command = KnowledgeIndexingWorkerCommands.permitStart(body(request));
        KnowledgeIndexingWorkerCommands.requireEvent(path, command.eventId());
        if (!permit.equals(command.permitId())) throw WorkerException.conflict("WORKER_IDENTITY_CONFLICT");
        return success(worker.startPermit(path, command,
            PrivateConnector.workerCertificateFingerprint(request)));
    }

    @PostMapping("/permit/{permitId}/complete")
    public ResponseEntity<ApiResponse<Map<String, Object>>> completePermit(@PathVariable String eventId,
            @PathVariable String permitId, HttpServletRequest request) throws IOException {
        UUID path = id(eventId);
        UUID permit = id(permitId);
        var command = KnowledgeIndexingWorkerCommands.permitComplete(body(request));
        KnowledgeIndexingWorkerCommands.requireEvent(path, command.eventId());
        if (!permit.equals(command.permitId())) throw WorkerException.conflict("WORKER_IDENTITY_CONFLICT");
        return success(worker.completePermit(path, command,
            PrivateConnector.workerCertificateFingerprint(request)));
    }

    private ResponseEntity<ApiResponse<Map<String, Object>>> success(Map<String, Object> data) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(responses.success(data));
    }

    private static UUID id(String value) {
        return WorkerJson.uuid(WorkerJson.MAPPER.createObjectNode().put("id", value), "id");
    }

    private static void correlation(HttpServletRequest request) {
        String value = request.getHeader("X-Request-Id");
        if (value == null || value.isBlank() || value.length() > 128
                || value.chars().anyMatch(Character::isISOControl)) {
            throw new WorkerException(422, "VALIDATION_ERROR");
        }
    }

    private static JsonNode body(HttpServletRequest request) throws IOException {
        correlation(request);
        try {
            MediaType type = MediaType.parseMediaType(request.getContentType() == null
                ? "" : request.getContentType());
            if (!MediaType.APPLICATION_JSON.isCompatibleWith(type)
                    || type.getCharset() != null && !StandardCharsets.UTF_8.equals(type.getCharset())
                    || request.getHeader("Content-Encoding") != null) {
                throw new WorkerException(415, "UNSUPPORTED_MEDIA_TYPE");
            }
        } catch (InvalidMediaTypeException invalid) {
            throw new WorkerException(415, "UNSUPPORTED_MEDIA_TYPE");
        }
        if (request.getContentLengthLong() > MAX_COMMAND_BYTES) {
            throw new WorkerException(413, "PAYLOAD_TOO_LARGE");
        }
        return WorkerJson.parse(request.getInputStream().readNBytes(MAX_COMMAND_BYTES + 1), MAX_COMMAND_BYTES);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse<Void>> error(Exception error) {
        int status = 503;
        String code = "SERVICE_UNAVAILABLE";
        if (error instanceof WorkerException workerError) {
            status = workerError.status();
            code = workerError.code();
        } else if (error instanceof org.springframework.dao.DuplicateKeyException) {
            status = 409;
            code = "WORKER_COMMAND_CONFLICT";
        }
        var response = ResponseEntity.status(status).cacheControl(CacheControl.noStore());
        if ("WORKER_ATTEMPT_BUSY".equals(code) || "WORKER_RETRY_BACKOFF".equals(code)) {
            response.header("Retry-After", "5");
        }
        return response.body(responses.error(code, "Knowledge indexing worker request could not be processed.", null));
    }
}
