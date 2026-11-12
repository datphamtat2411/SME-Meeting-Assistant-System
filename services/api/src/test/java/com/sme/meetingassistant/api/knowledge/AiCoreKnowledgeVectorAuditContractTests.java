package com.sme.meetingassistant.api.knowledge;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.sme.meetingassistant.api.transport.AiCoreTransport;
import java.net.http.HttpResponse;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/** Internal audit responses remain a fail-closed, exact-version contract. */
class AiCoreKnowledgeVectorAuditContractTests {
    private static final String GEN = "rag-t02-bge-m3-v1";
    private static final UUID MEETING = UUID.fromString("11111111-1111-4111-8111-111111111111");
    private static final UUID SOURCE = UUID.fromString("22222222-2222-4222-8222-222222222222");

    @SuppressWarnings("unchecked")
    private static AiCoreKnowledgeVectorAudit client(String body) throws Exception {
        AiCoreTransport transport=mock(AiCoreTransport.class);
        HttpResponse<String> response=mock(HttpResponse.class);
        when(response.statusCode()).thenReturn(200);
        when(response.body()).thenReturn(body);
        when(transport.post(eq("/internal/v1/knowledge-indexing/reconciliation/inventory"),anyString()))
            .thenReturn(response);
        return new AiCoreKnowledgeVectorAudit(transport, JsonMapper.builder().build());
    }

    private static String response(String records, String cursor) {
        return "{\"contractVersion\":\"1.0\",\"generationId\":\""+GEN+
            "\",\"records\":"+records+",\"nextCursor\":"+cursor+"}";
    }

    @Test
    void acceptsStrictBoundedPaginatedIdentityWithoutContent() throws Exception {
        String records = "[{\"sourceIdentity\":{\"sourceType\":\"ACTION_ITEM\",\"sourceId\":\""+
            SOURCE+"\",\"meetingId\":\""+MEETING+"\"},\"sourceRevision\":{\"number\":3}}]";
        var page=client(response(records,"\"7\"")).inventoryPage(GEN,null,10);
        assertThat(page.sources()).containsExactly(new KnowledgeVectorAudit.SourceKey(
            "ACTION_ITEM",SOURCE,MEETING,3));
        assertThat(page.nextCursor()).isEqualTo("7");
        assertThat(client(response("[]","null")).inventoryPage(GEN,"7",10).sources()).isEmpty();
    }

    @Test
    void rejectsUntrustedResponseAndNonprogressingCursor() throws Exception {
        String records = "[{\"sourceIdentity\":{\"sourceType\":\"ACTION_ITEM\",\"sourceId\":\""+
            SOURCE+"\",\"meetingId\":\""+MEETING+"\"},\"sourceRevision\":{\"number\":3}}]";
        assertThatThrownBy(() -> client(response(records,"\"7\"")).inventoryPage(GEN,"7",10))
            .isInstanceOf(AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException.class);
        assertThatThrownBy(() -> client(response(records,"null").replace("\"1.0\"","\"9.0\""))
            .inventoryPage(GEN,null,10))
            .isInstanceOf(AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException.class);
        assertThatThrownBy(() -> client(response(records.replace("\"number\":3",
            "\"number\":-1"),"null")).inventoryPage(GEN,null,10))
            .isInstanceOf(AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException.class);
        assertThatThrownBy(() -> client(response(records,"null").replace("\"nextCursor\"",
            "\"unexpectedField\"")).inventoryPage(GEN,null,10))
            .isInstanceOf(AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException.class);
    }
}
