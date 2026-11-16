package com.sme.meetingassistant.api.knowledge;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.sme.meetingassistant.api.transport.AiCoreTransport;
import java.net.http.HttpResponse;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import tools.jackson.databind.json.JsonMapper;

/** Internal audit responses remain a fail-closed, exact-version contract. */
class AiCoreKnowledgeVectorAuditContractTests {
    private static final String GEN = "rag-t02-bge-m3-v1";
    private static final UUID MEETING = UUID.fromString("11111111-1111-4111-8111-111111111111");
    private static final UUID SOURCE = UUID.fromString("22222222-2222-4222-8222-222222222222");

    @SuppressWarnings("unchecked")
    private static AiCoreKnowledgeVectorAudit client(String body) throws Exception {
        return client(200, body);
    }

    @SuppressWarnings("unchecked")
    private static AiCoreKnowledgeVectorAudit client(int status, String body) throws Exception {
        AiCoreTransport transport=mock(AiCoreTransport.class);
        HttpResponse<String> response=mock(HttpResponse.class);
        when(response.statusCode()).thenReturn(status);
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
    void sendsCanonicalNumericAndUuidCursors() throws Exception {
        AiCoreTransport transport=mock(AiCoreTransport.class);
        HttpResponse<String> response=mock(HttpResponse.class);
        when(response.statusCode()).thenReturn(200);
        when(response.body()).thenReturn(response("[]", "null"));
        when(transport.post(eq("/internal/v1/knowledge-indexing/reconciliation/inventory"), anyString()))
            .thenReturn(response);
        var audit = new AiCoreKnowledgeVectorAudit(transport, JsonMapper.builder().build());

        audit.inventoryPage(GEN, "0007", 10);
        audit.inventoryPage(GEN, "22222222222222222222222222222222", 10);
        audit.inventoryPage(GEN, "18446744073709551615", 10);

        ArgumentCaptor<String> requests = ArgumentCaptor.forClass(String.class);
        verify(transport, times(3)).post(
            eq("/internal/v1/knowledge-indexing/reconciliation/inventory"), requests.capture());
        assertThat(requests.getAllValues().get(0)).contains("\"cursor\":\"7\"");
        assertThat(requests.getAllValues().get(1))
            .contains("\"cursor\":\"22222222-2222-2222-2222-222222222222\"");
        assertThat(requests.getAllValues().get(2)).contains("\"cursor\":\"18446744073709551615\"");
    }

    @Test
    void rejectsInvalidPersistedCursorBeforeHttpTransport() throws Exception {
        AiCoreTransport transport=mock(AiCoreTransport.class);
        var audit = new AiCoreKnowledgeVectorAudit(transport, JsonMapper.builder().build());
        for (String cursor : new String[] {
            "abcd", "bad-cursor", "-1", "", " ", " 7", "7 ",
            "18446744073709551616", "123456789012345678901", "１２３", "a".repeat(37)
        }) {
            assertThatThrownBy(() -> audit.inventoryPage(GEN, cursor, 10))
                .isInstanceOf(AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException.class)
                .extracting(error -> ((AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException) error).kind())
                .isEqualTo(AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException.FailureKind.INVALID_CHECKPOINT);
        }
        verifyNoInteractions(transport);
    }

    @Test
    void rejectsUntrustedResponseAndNonprogressingCursor() throws Exception {
        String records = "[{\"sourceIdentity\":{\"sourceType\":\"ACTION_ITEM\",\"sourceId\":\""+
            SOURCE+"\",\"meetingId\":\""+MEETING+"\"},\"sourceRevision\":{\"number\":3}}]";
        var cycle = catchFailure(() -> client(response(records,"\"7\"")).inventoryPage(GEN,"7",10));
        assertThat(cycle.kind()).isEqualTo(
            AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException.FailureKind.CURSOR_CYCLE);
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

    @Test
    void rejectsMalformedOrUnsupportedNextCursorAsInvalidUpstreamResponse() throws Exception {
        String records = "[{\"sourceIdentity\":{\"sourceType\":\"ACTION_ITEM\",\"sourceId\":\""
            + SOURCE + "\",\"meetingId\":\"" + MEETING
            + "\"},\"sourceRevision\":{\"number\":3}}]";
        for (String cursor : new String[] {
            "\"abcd\"", "true", "{}", "\"18446744073709551616\""
        }) {
            var failure = catchFailure(() -> client(response(records, cursor))
                .inventoryPage(GEN, "7", 10));
            assertThat(failure.kind()).isEqualTo(
                AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException.FailureKind.INVALID_RESPONSE);
        }
    }

    @Test
    void classifiesCanonicalNumericSelfLoopAliasesAsCursorCycles() throws Exception {
        String records = "[{\"sourceIdentity\":{\"sourceType\":\"ACTION_ITEM\",\"sourceId\":\""
            + SOURCE + "\",\"meetingId\":\"" + MEETING
            + "\"},\"sourceRevision\":{\"number\":3}}]";
        for (String[] alias : new String[][] {
            {"7", "\"7\""},
            {"0007", "\"7\""},
            {"7", "\"0007\""},
        }) {
            var failure = catchFailure(() -> client(response(records, alias[1]))
                .inventoryPage(GEN, alias[0], 10));
            assertThat(failure.kind()).isEqualTo(
                AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException.FailureKind.CURSOR_CYCLE);
            assertThat(failure.reconciliationCode()).isEqualTo("VECTOR_CURSOR_CYCLE");
        }
    }

    @Test
    void classifiesCanonicalUuidSelfLoopAliasesAsCursorCycles() throws Exception {
        String records = "[{\"sourceIdentity\":{\"sourceType\":\"ACTION_ITEM\",\"sourceId\":\""
            + SOURCE + "\",\"meetingId\":\"" + MEETING
            + "\"},\"sourceRevision\":{\"number\":3}}]";
        for (String[] alias : new String[][] {
            {"abcdefab-cdef-4abc-8def-abcdefabcdef", "\"ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF\""},
            {"ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF", "\"abcdefabcdef4abc8defabcdefabcdef\""},
            {"abcdefabcdef4abc8defabcdefabcdef", "\"abcdefab-cdef-4abc-8def-abcdefabcdef\""},
        }) {
            var failure = catchFailure(() -> client(response(records, alias[1]))
                .inventoryPage(GEN, alias[0], 10));
            assertThat(failure.kind()).isEqualTo(
                AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException.FailureKind.CURSOR_CYCLE);
            assertThat(failure.reconciliationCode()).isEqualTo("VECTOR_CURSOR_CYCLE");
        }
    }

    @Test
    void rejectsEmptyNonterminalPageAsInvalidResponseRatherThanCursorCycle() throws Exception {
        var failure = catchFailure(() -> client(response("[]", "\"8\""))
            .inventoryPage(GEN, "7", 10));
        assertThat(failure.kind()).isEqualTo(
            AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException.FailureKind.INVALID_RESPONSE);
    }

    @Test
    void preservesGenerationMismatchAndMalformedResponseRejection() throws Exception {
        var generationFailure = catchFailure(() -> client(409, "{}").inventoryPage(GEN, null, 10));
        assertThat(generationFailure.kind()).isEqualTo(
            AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException.FailureKind.GENERATION_MISMATCH);

        var malformed = catchFailure(() -> client("{").inventoryPage(GEN, null, 10));
        assertThat(malformed.kind()).isEqualTo(
            AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException.FailureKind.INVALID_RESPONSE);

        var oversized = catchFailure(() -> client("{}" + "x".repeat(256 * 1024))
            .inventoryPage(GEN, null, 10));
        assertThat(oversized.kind()).isEqualTo(
            AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException.FailureKind.UNAVAILABLE);

        var integrity = catchFailure(() -> client(503,
            "{\"error\":{\"code\":\"inventory_integrity_failure\","
                + "\"message\":\"Knowledge inventory unavailable\"}}")
            .inventoryPage(GEN, null, 10));
        assertThat(integrity.kind()).isEqualTo(
            AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException.FailureKind.INVALID_RESPONSE);
    }

    @Test
    void mapsOnlyTheStrictDedicated503ErrorEnvelopeToCursorCycle() throws Exception {
        var cycle = catchFailure(() -> client(503,
            "{\"error\":{\"code\":\"inventory_cursor_cycle\","
                + "\"message\":\"Knowledge inventory unavailable\"}}")
            .inventoryPage(GEN, null, 10));
        assertThat(cycle.kind()).isEqualTo(
            AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException.FailureKind.CURSOR_CYCLE);
        assertThat(cycle.reconciliationCode()).isEqualTo("VECTOR_CURSOR_CYCLE");

        for (String body : new String[] {
            "{\"error\":{\"code\":\"inventory_cursor_cycle\"}}",
            "{\"message\":\"inventory_cursor_cycle\"}",
            "{\"error\":{\"code\":\"INVENTORY_CURSOR_CYCLE\","
                + "\"message\":\"Knowledge inventory unavailable\"}}",
            "{\"error\":{\"code\":\"unknown\","
                + "\"message\":\"inventory_cursor_cycle\"}}",
            "{\"error\":{\"code\":\"inventory_cursor_cycle\","
                + "\"message\":\"Knowledge inventory unavailable\",\"extra\":true}}",
            "{\"error\":{\"code\":\"inventory_cursor_cycle\","
                + "\"message\":\"Knowledge inventory unavailable\"}} trailing",
        }) {
            var failure = catchFailure(() -> client(503, body).inventoryPage(GEN, null, 10));
            assertThat(failure.kind()).isEqualTo(
                AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException.FailureKind.UNAVAILABLE);
        }

        var successfulStatus = catchFailure(() -> client(200,
            "{\"error\":{\"code\":\"inventory_cursor_cycle\","
                + "\"message\":\"Knowledge inventory unavailable\"}}")
            .inventoryPage(GEN, null, 10));
        assertThat(successfulStatus.kind()).isEqualTo(
            AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException.FailureKind.INVALID_RESPONSE);
    }

    private static AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException catchFailure(
            ThrowingCall call) throws Exception {
        try {
            call.run();
        } catch (AiCoreKnowledgeVectorAudit.KnowledgeVectorAuditException failure) {
            return failure;
        }
        throw new AssertionError("Expected vector audit failure");
    }

    @FunctionalInterface
    private interface ThrowingCall {
        void run() throws Exception;
    }
}
