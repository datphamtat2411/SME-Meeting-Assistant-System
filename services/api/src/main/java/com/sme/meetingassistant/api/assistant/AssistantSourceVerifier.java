package com.sme.meetingassistant.api.assistant;

import com.sme.meetingassistant.api.knowledge.KnowledgeIndexingWorkerService;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Component;

/** A citation is evidence only while Core verifies its canonical current revision. */
public interface AssistantSourceVerifier {
    boolean current(String sourceType, UUID sourceId, UUID meetingId, long revision);
}

@Component
final class CoreAssistantSourceVerifier implements AssistantSourceVerifier {
    private final KnowledgeIndexingWorkerService sources;
    CoreAssistantSourceVerifier(KnowledgeIndexingWorkerService sources) { this.sources=sources; }
    @Override
    public boolean current(String type, UUID source, UUID meeting, long revision) {
        List<Map<String,Object>> matches=sources.verifySources(List.of(
            new KnowledgeIndexingWorkerService.SourceVerificationRequest(type,source,meeting,revision)));
        if (matches.size()!=1) return false;
        Map<String,Object> record=matches.getFirst();
        return "CURRENT".equals(record.get("status"))
            && Boolean.TRUE.equals(record.get("eligible"))
            && Boolean.TRUE.equals(record.get("visible"))
            && Boolean.TRUE.equals(record.get("available"));
    }
}
