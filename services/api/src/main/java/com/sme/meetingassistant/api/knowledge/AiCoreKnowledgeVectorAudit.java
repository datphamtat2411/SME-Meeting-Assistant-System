package com.sme.meetingassistant.api.knowledge;

import com.sme.meetingassistant.api.media.worker.WorkerJson;
import com.sme.meetingassistant.api.transport.AiCoreTransport;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** Core-side client for the AI-owned, read-only Qdrant reconciliation boundary. */
@Component
@ConditionalOnBean(AiCoreTransport.class)
public class AiCoreKnowledgeVectorAudit implements KnowledgeVectorAudit {
    private static final String PATH = "/internal/v1/knowledge-indexing/reconciliation";
    private static final int MAX_JSON_BYTES = 256 * 1024;
    private final AiCoreTransport transport;
    private final ObjectMapper json;

    public AiCoreKnowledgeVectorAudit(AiCoreTransport transport, ObjectMapper json) {
        this.transport = transport;
        this.json = json;
    }

    @Override
    public Map<SourceKey, Long> countPoints(String generationId, List<SourceKey> sources) {
        if (generationId == null || generationId.isBlank() || sources == null
                || sources.isEmpty() || sources.size() > 500) {
            throw new KnowledgeVectorAuditException();
        }
        try {
            var request = json.createObjectNode();
            request.put("contractVersion", "1.0");
            request.put("generationId", generationId);
            var requests = request.putArray("requests");
            for (SourceKey source : sources) {
                if (source == null || source.sourceType() == null || source.sourceId() == null
                        || source.meetingId() == null || source.sourceRevision() < 0) {
                    throw new KnowledgeVectorAuditException();
                }
                var value = requests.addObject();
                var identity = value.putObject("sourceIdentity");
                identity.put("sourceType", source.sourceType());
                identity.put("sourceId", source.sourceId().toString());
                identity.put("meetingId", source.meetingId().toString());
                value.putObject("sourceRevision").put("number", source.sourceRevision());
            }
            var response = transport.post(PATH, json.writeValueAsString(request));
            if (response.statusCode() != 200 || response.body() == null
                    || response.body().getBytes(StandardCharsets.UTF_8).length > MAX_JSON_BYTES) {
                throw new KnowledgeVectorAuditException();
            }
            return decode(response.body(), generationId, sources);
        } catch (KnowledgeVectorAuditException error) {
            throw error;
        } catch (IOException error) {
            throw new KnowledgeVectorAuditException();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new KnowledgeVectorAuditException();
        } catch (RuntimeException error) {
            throw new KnowledgeVectorAuditException();
        }
    }

    private Map<SourceKey, Long> decode(String body, String generationId, List<SourceKey> expected) {
        JsonNode root = WorkerJson.parse(body.getBytes(StandardCharsets.UTF_8), MAX_JSON_BYTES);
        WorkerJson.fields(root, "contractVersion", "generationId", "records");
        WorkerJson.require("1.0".equals(WorkerJson.string(root, "contractVersion", 8)));
        WorkerJson.require(generationId.equals(WorkerJson.string(root, "generationId", 128)));
        JsonNode records = WorkerJson.array(root, "records", expected.size(), expected.size());
        Map<SourceKey, Long> result = new LinkedHashMap<>();
        for (JsonNode record : records) {
            WorkerJson.fields(record, "sourceIdentity", "sourceRevision", "pointCount");
            JsonNode identity = record.get("sourceIdentity");
            WorkerJson.fields(identity, "sourceType", "sourceId", "meetingId");
            String sourceType = WorkerJson.choice(identity, "sourceType", "TRANSCRIPT", "SUMMARY", "DECISION",
                "ACTION_ITEM");
            UUID sourceId = WorkerJson.uuid(identity, "sourceId");
            UUID meetingId = WorkerJson.uuid(identity, "meetingId");
            JsonNode revision = record.get("sourceRevision");
            WorkerJson.fields(revision, "number");
            long sourceRevision = WorkerJson.number(revision, "number", 0, Long.MAX_VALUE);
            long pointCount = WorkerJson.number(record, "pointCount", 0, Long.MAX_VALUE);
            SourceKey source = new SourceKey(sourceType, sourceId, meetingId, sourceRevision);
            WorkerJson.require(expected.contains(source) && result.put(source, pointCount) == null);
        }
        WorkerJson.require(result.size() == expected.size());
        return result;
    }

    public static final class KnowledgeVectorAuditException extends RuntimeException {
        public KnowledgeVectorAuditException() {
            super("AI vector audit unavailable");
        }
    }
}
