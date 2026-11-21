package com.sme.meetingassistant.api.assistant;

import com.sme.meetingassistant.api.transport.AiCoreTransport;
import java.net.http.HttpResponse;
import java.time.Duration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.stereotype.Component;

/** Reuses dedicated outbound mTLS service identity and HTTPS-only origin validation. */
@Component
@ConditionalOnBean(AiCoreTransport.class)
final class AiCoreAssistantGateway implements AssistantAiGateway {
    private final AiCoreTransport transport;
    AiCoreAssistantGateway(AiCoreTransport transport) { this.transport=transport; }

    @Override public String answer(String request) throws Exception {
        HttpResponse<String> response=transport.post("/internal/v1/assistant/answers", request,
            Duration.ofSeconds(45));
        // AI returns a strict FAILED envelope for expected inference/dependency failures.
        if (response.statusCode()!=200 && response.statusCode()!=403 && response.statusCode()!=422
                && response.statusCode()!=503 && response.statusCode()!=504) {
            throw new IllegalStateException("Assistant upstream response not accepted");
        }
        if (response.body()==null || response.body().getBytes(java.nio.charset.StandardCharsets.UTF_8).length>256*1024)
            throw new IllegalStateException("Assistant upstream response invalid");
        return response.body();
    }
}
