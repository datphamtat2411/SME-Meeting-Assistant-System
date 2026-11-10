package com.sme.meetingassistant.api.knowledge;

import com.sme.meetingassistant.api.common.ApiResponse;
import com.sme.meetingassistant.api.common.ApiResponseFactory;
import com.sme.meetingassistant.api.media.worker.WorkerException;
import com.sme.meetingassistant.api.media.worker.WorkerJson;
import com.sme.meetingassistant.api.transport.PrivateConnector;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

/** Private mTLS Core authority check used by retrieval; it returns no canonical content. */
@RestController
@RequestMapping("/internal/v1/worker/knowledge-indexing/source-verification")
@ConditionalOnProperty(prefix = "app.media.knowledge-indexing", name = "enabled", havingValue = "true")
public class KnowledgeSourceVerificationController {
    private static final int MAX_COMMAND_BYTES = 64 * 1024;
    private final KnowledgeIndexingWorkerService worker;
    private final ApiResponseFactory responses;

    public KnowledgeSourceVerificationController(KnowledgeIndexingWorkerService worker,
            ApiResponseFactory responses) {
        this.worker = worker;
        this.responses = responses;
    }

    @PostMapping
    public ResponseEntity<ApiResponse<Map<String, Object>>> verify(HttpServletRequest request) throws IOException {
        PrivateConnector.workerCertificateFingerprint(request);
        JsonNode body = body(request);
        WorkerJson.fields(body, "contractVersion", "requests");
        WorkerJson.require("1.0".equals(WorkerJson.string(body, "contractVersion", 8)));
        JsonNode values = WorkerJson.array(body, "requests", 1, 256);
        List<KnowledgeIndexingWorkerService.SourceVerificationRequest> requests = new ArrayList<>();
        for (JsonNode value : values) {
            WorkerJson.fields(value, "sourceIdentity", "sourceRevision");
            JsonNode identity = value.get("sourceIdentity");
            WorkerJson.fields(identity, "sourceType", "sourceId", "meetingId");
            String sourceType = WorkerJson.choice(identity, "sourceType", "TRANSCRIPT", "SUMMARY", "DECISION",
                "ACTION_ITEM");
            UUID sourceId = WorkerJson.uuid(identity, "sourceId");
            UUID meetingId = WorkerJson.uuid(identity, "meetingId");
            JsonNode revision = value.get("sourceRevision");
            WorkerJson.fields(revision, "number");
            long number = WorkerJson.number(revision, "number", 0, Long.MAX_VALUE);
            requests.add(new KnowledgeIndexingWorkerService.SourceVerificationRequest(sourceType, sourceId,
                meetingId, number));
        }
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .contentType(MediaType.APPLICATION_JSON)
            .body(responses.success(Map.of("contractVersion", "1.0", "records",
                worker.verifySources(requests))));
    }

    private static JsonNode body(HttpServletRequest request) throws IOException {
        if (request.getContentLengthLong() > MAX_COMMAND_BYTES) throw new WorkerException(413, "PAYLOAD_TOO_LARGE");
        return WorkerJson.parse(request.getInputStream().readNBytes(MAX_COMMAND_BYTES + 1), MAX_COMMAND_BYTES);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse<Void>> error(Exception error) {
        int status = error instanceof WorkerException workerError ? workerError.status() : 503;
        String code = error instanceof WorkerException workerError ? workerError.code() : "SERVICE_UNAVAILABLE";
        return ResponseEntity.status(status).cacheControl(CacheControl.noStore())
            .body(responses.error(code, "Knowledge source verification could not be completed.", null));
    }
}
