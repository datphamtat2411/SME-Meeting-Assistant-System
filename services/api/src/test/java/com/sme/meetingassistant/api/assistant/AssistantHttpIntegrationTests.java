package com.sme.meetingassistant.api.assistant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** Real Flyway/PostgreSQL, request security and HTTP boundary; only AI provider is controlled. */
@ActiveProfiles("test")
@SpringBootTest(properties={"app.assistant.enabled=true","app.media.outbox.enabled=false"})
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class AssistantHttpIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @MockitoBean AssistantAiGateway gateway;
    @MockitoBean AssistantSourceVerifier sourceVerifier;

    private UUID user() {
        return user("EMPLOYEE");
    }
    private UUID user(String role) {
        UUID id=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Assistant actor','test-only',?,'ACTIVE')
            """,id,id+"@test.invalid",id+"@test.invalid",role);
        return id;
    }
    private UUID meeting(UUID owner, UUID... members) {
        UUID id=UUID.randomUUID();
        jdbc.update("INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id) VALUES (?,'Assistant test',?,?)",
            id,owner,owner);
        for(UUID member:members) jdbc.update("""
            INSERT INTO meeting_participants(id,meeting_id,user_id,added_by_user_id)
            VALUES (?,?,?,?)""",UUID.randomUUID(),id,member,owner);
        return id;
    }
    private Principal principal(UUID id) {return ()->id.toString();}
    private JsonNode response(org.springframework.test.web.servlet.MvcResult result) throws Exception {
        return json.readTree(result.getResponse().getContentAsString()).path("data");
    }
    private UUID conversation(UUID actor,UUID meeting) throws Exception {
        JsonNode d=response(mvc.perform(post("/api/v1/assistant/conversations")
            .principal(principal(actor)).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("meetingId",meeting,"title","Project notes"))))
            .andExpect(status().isCreated()).andReturn());
        return UUID.fromString(d.path("id").asText());
    }
    private String target(UUID conversation) {
        return "/api/v1/assistant/conversations/"+conversation+"/messages";
    }
    private String insufficient(String requestJson) throws Exception {
        JsonNode req=json.readTree(requestJson);
        return json.writeValueAsString(Map.of(
            "contractVersion","1.0","requestId",req.path("requestId").asText(),
            "status","INSUFFICIENT_EVIDENCE","answer","Không tìm thấy bằng chứng phù hợp.",
            "scopeId",req.path("authorizedScope").path("scopeId").asText(),
            "scopeVersion",req.path("authorizedScope").path("scopeVersion").asText(),
            "claims",List.of(),"citations",List.of(),"diagnostics",Map.of(),"failures",List.of()));
    }
    @Test void historyPaginationPreservesEveryMessageAndStableOrdering() throws Exception {
        UUID owner=user(),id=conversation(owner,meeting(owner));
        // Equal timestamps exercise the canonical UUID tie-breaker as well as
        // the lookahead boundary. No inference or admission quota is involved.
        List<String> newestFirst=new java.util.ArrayList<>();
        for(int i=1;i<=12;i++){
            UUID message=new UUID(0,i);
            // Use a random namespace so other tests/runs cannot collide.
            message=new UUID(id.getMostSignificantBits(),message.getLeastSignificantBits());
            jdbc.update("""
                INSERT INTO assistant_messages(id,conversation_id,role,content,created_at)
                VALUES (?,?,'USER','Question',TIMESTAMPTZ '2026-01-01 00:00:00+00')
                """,message,id);
            newestFirst.addFirst(message.toString());
        }
        for(int size:List.of(1,4,5,12,50)){
            List<String> actual=new java.util.ArrayList<>();
            for(int page=0;page<=12/size;page++){
                JsonNode detail=response(mvc.perform(get("/api/v1/assistant/conversations/"+id)
                    .principal(principal(owner)).param("page",String.valueOf(page))
                    .param("size",String.valueOf(size))).andExpect(status().isOk()).andReturn());
                assertThat(detail.path("page").asInt()).isEqualTo(page);
                assertThat(detail.path("size").asInt()).isEqualTo(size);
                int from=page*size,to=Math.min(from+size,12);
                List<String> expected=new java.util.ArrayList<>(newestFirst.subList(from,to));
                java.util.Collections.reverse(expected);
                List<String> pageIds=new java.util.ArrayList<>();
                for(JsonNode row:detail.path("messages"))pageIds.add(row.path("id").asText());
                assertThat(pageIds).containsExactlyElementsOf(expected);
                assertThat(detail.path("hasMore").asBoolean()).isEqualTo(to<12);
                java.util.Collections.reverse(pageIds);
                actual.addAll(pageIds);
            }
            assertThat(actual).containsExactlyElementsOf(newestFirst);
        }
        UUID empty=conversation(owner,meeting(owner));
        JsonNode detail=response(mvc.perform(get("/api/v1/assistant/conversations/"+empty)
            .principal(principal(owner))).andExpect(status().isOk()).andReturn());
        assertThat(detail.path("messages").size()).isZero();
        assertThat(detail.path("hasMore").asBoolean()).isFalse();
    }

    @Test void creationKeyIsScopedAndReplaysWithoutAnotherQuotaEvent() throws Exception {
        UUID owner=user(),member=user(),meeting=meeting(owner,member);
        String body=json.writeValueAsString(Map.of("meetingId",meeting,"title"," Project notes "));
        String endpoint="/api/v1/assistant/conversations";
        String key="create-intent-01";
        JsonNode first=response(mvc.perform(post(endpoint).principal(principal(owner))
            .header("Idempotency-Key",key).contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isCreated()).andReturn());
        JsonNode replay=response(mvc.perform(post(endpoint).principal(principal(owner))
            .header("Idempotency-Key",key).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("meetingId",meeting,"title","Project notes"))))
            .andExpect(status().isCreated()).andReturn());
        assertThat(replay.path("id").asText()).isEqualTo(first.path("id").asText());
        assertThat(jdbc.queryForObject("SELECT count(*) FROM assistant_conversations WHERE user_id=?",
            Integer.class,owner)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM assistant_admission_events WHERE user_id=? AND event_type='CONVERSATION_CREATE'
            """,Integer.class,owner)).isEqualTo(1);
        mvc.perform(post(endpoint).principal(principal(owner)).header("Idempotency-Key",key)
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("meetingId",meeting,"title","Different"))))
            .andExpect(status().isConflict());
        JsonNode other=response(mvc.perform(post(endpoint).principal(principal(member))
            .header("Idempotency-Key",key).contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isCreated()).andReturn());
        assertThat(other.path("id").asText()).isNotEqualTo(first.path("id").asText());
        jdbc.update("UPDATE meeting_participants SET removed_at=CURRENT_TIMESTAMP WHERE meeting_id=? AND user_id=?",
            meeting,member);
        mvc.perform(post(endpoint).principal(principal(member)).header("Idempotency-Key",key)
            .contentType(MediaType.APPLICATION_JSON).content(body)).andExpect(status().isNotFound());
    }

    @Test void anchoredHistoryDoesNotShiftWhenNewMessagesArrive() throws Exception {
        UUID owner=user(),id=conversation(owner,meeting(owner));
        String endpoint="/api/v1/assistant/conversations/"+id;
        List<UUID> ids=new java.util.ArrayList<>();
        for(int i=1;i<=7;i++){
            UUID message=new UUID(id.getMostSignificantBits(),i);
            ids.add(message);
            jdbc.update("""
                INSERT INTO assistant_messages(id,conversation_id,role,content,created_at)
                VALUES (?,?,'USER','Question',TIMESTAMPTZ '2026-01-01 00:00:00+00')
                """,message,id);
        }
        JsonNode first=response(mvc.perform(get(endpoint).principal(principal(owner)).param("size","3"))
            .andExpect(status().isOk()).andReturn());
        assertThat(first.path("messages").get(0).path("id").asText()).isEqualTo(ids.get(4).toString());
        UUID newer=UUID.randomUUID();
        jdbc.update("INSERT INTO assistant_messages(id,conversation_id,role,content) VALUES (?,?,'USER','New')",
            newer,id);
        JsonNode older=response(mvc.perform(get(endpoint).principal(principal(owner)).param("size","3")
            .param("beforeMessageId",ids.get(4).toString())).andExpect(status().isOk()).andReturn());
        List<String> actual=new java.util.ArrayList<>();
        for(JsonNode row:older.path("messages"))actual.add(row.path("id").asText());
        assertThat(actual).containsExactly(ids.get(1).toString(),ids.get(2).toString(),ids.get(3).toString());
        assertThat(older.path("hasMore").asBoolean()).isTrue();
        JsonNode last=response(mvc.perform(get(endpoint).principal(principal(owner)).param("size","3")
            .param("beforeMessageId",ids.get(1).toString())).andExpect(status().isOk()).andReturn());
        assertThat(last.path("messages").size()).isEqualTo(1);
        assertThat(last.path("messages").get(0).path("id").asText()).isEqualTo(ids.getFirst().toString());
        assertThat(last.path("hasMore").asBoolean()).isFalse();
        mvc.perform(get(endpoint).principal(principal(owner)).param("beforeMessageId",UUID.randomUUID().toString()))
            .andExpect(status().isNotFound());
        mvc.perform(get(endpoint).principal(principal(owner)).param("page","1")
            .param("beforeMessageId",ids.getFirst().toString())).andExpect(status().isUnprocessableEntity());
    }

    @Test void turnStatusIsReadOnlyAndDistinguishesExpiredLease() throws Exception {
        UUID owner=user(),id=conversation(owner,meeting(owner)),message=UUID.randomUUID(),turn=UUID.randomUUID();
        String endpoint="/api/v1/assistant/conversations/"+id+"/turns/by-key";
        jdbc.update("INSERT INTO assistant_messages(id,conversation_id,role,content) VALUES (?,?,'USER','Question')",
            message,id);
        jdbc.update("""
            INSERT INTO assistant_turns(id,conversation_id,idempotency_key,request_sha256,user_message_id,
                state,claim_token,claim_expires_at,scope_version)
            VALUES (?,?,?,?,?,'PROCESSING',?,clock_timestamp()+INTERVAL '120 seconds','test-v1')
            """,turn,id,"read-status","a".repeat(64),message,UUID.randomUUID());
        JsonNode live=response(mvc.perform(get(endpoint).principal(principal(owner))
            .header("Idempotency-Key","read-status")).andExpect(status().isOk()).andReturn());
        assertThat(live.path("turn").path("state").asText()).isEqualTo("PROCESSING");
        assertThat(live.path("turn").path("userMessageId").asText()).isEqualTo(message.toString());
        assertThat(live.path("recoveryEligible").asBoolean()).isFalse();
        jdbc.update("UPDATE assistant_turns SET claim_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=?",turn);
        JsonNode expired=response(mvc.perform(get(endpoint).principal(principal(owner))
            .header("Idempotency-Key","read-status")).andExpect(status().isOk()).andReturn());
        assertThat(expired.path("recoveryEligible").asBoolean()).isTrue();
        assertThat(jdbc.queryForObject("SELECT state FROM assistant_turns WHERE id=?",String.class,turn))
            .isEqualTo("PROCESSING");
        mvc.perform(get(endpoint).principal(principal(user())).header("Idempotency-Key","read-status"))
            .andExpect(status().isNotFound());
        mvc.perform(get(endpoint).principal(principal(owner)).header("Idempotency-Key","missing-key"))
            .andExpect(status().isNotFound());
        verifyNoInteractions(gateway);
    }

    @Test void ownerAndCurrentMeetingMembershipAreBothRequired() throws Exception {
        UUID owner=user(),member=user(),outsider=user(),meeting=meeting(owner,member);
        UUID id=conversation(member,meeting);
        mvc.perform(get("/api/v1/assistant/conversations/"+id).principal(principal(member)))
            .andExpect(status().isOk());
        mvc.perform(get("/api/v1/assistant/conversations/"+id).principal(principal(owner)))
            .andExpect(status().isNotFound());
        mvc.perform(post("/api/v1/assistant/conversations").principal(principal(outsider))
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(Map.of("meetingId",meeting))))
            .andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/assistant/conversations").principal(principal(owner)))
            .andExpect(status().isOk());
        jdbc.update("UPDATE meeting_participants SET removed_at=CURRENT_TIMESTAMP WHERE meeting_id=? AND user_id=?",
            meeting,member);
        mvc.perform(get("/api/v1/assistant/conversations/"+id).principal(principal(member)))
            .andExpect(status().isNotFound());
        JsonNode list=response(mvc.perform(get("/api/v1/assistant/conversations")
            .principal(principal(member))).andExpect(status().isOk()).andReturn());
        assertThat(list.size()).isZero();
    }
    @Test void managerAndAdministratorFollowUpsRemainBoundToOwnedMeeting() throws Exception {
        UUID owner=user(),manager=user("DEPARTMENT_MANAGER"),admin=user("ADMINISTRATOR");
        UUID selected=meeting(owner,manager,admin),other=meeting(owner,manager,admin);
        UUID restricted=meeting(owner);
        var requests=new java.util.ArrayList<JsonNode>();
        when(gateway.answer(anyString())).thenAnswer(inv->{
            String payload=inv.getArgument(0);
            requests.add(json.readTree(payload));
            return insufficient(payload);
        });

        UUID previousConversation=null;
        for(UUID actor:List.of(manager,admin)){
            // Global roles and knowledge of a meeting identifier are not content grants.
            mvc.perform(post("/api/v1/assistant/conversations").principal(principal(actor))
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("meetingId",restricted))))
                .andExpect(status().isNotFound());

            UUID own=conversation(actor,selected);
            UUID separate=conversation(actor,other);
            if(previousConversation!=null){
                mvc.perform(get("/api/v1/assistant/conversations/"+previousConversation)
                    .principal(principal(actor))).andExpect(status().isNotFound());
            }
            previousConversation=own;

            // Give the same principal unrelated conversation context to catch
            // accidentally user-wide rather than conversation-wide history.
            String otherQuestion="Nội dung riêng của cuộc họp B";
            String firstQuestion="Quyết định của cuộc họp A là gì?";
            String followUp="Còn cuộc họp khác thì sao?";
            int first=requests.size();
            for(var entry:List.of(Map.entry(separate,otherQuestion),
                                  Map.entry(own,firstQuestion),
                                  Map.entry(own,followUp))){
                mvc.perform(post(target(entry.getKey())).principal(principal(actor))
                    .header("Idempotency-Key","scope-"+UUID.randomUUID())
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(json.writeValueAsString(Map.of("question",entry.getValue()))))
                    .andExpect(status().isOk());
            }
            assertThat(requests).hasSize(first+3);
            for(int i=0;i<3;i++){
                JsonNode sent=requests.get(first+i);
                JsonNode scope=sent.path("authorizedScope");
                assertThat(scope.path("principalId").asText()).isEqualTo(actor.toString());
                assertThat(scope.path("scopeId").asText())
                    .isEqualTo((i==0?separate:own).toString());
                assertThat(scope.path("allowedMeetingIds")).hasSize(1);
                assertThat(scope.path("allowedMeetingIds").get(0).asText())
                    .isEqualTo((i==0?other:selected).toString());
            }
            assertThat(requests.get(first+1).path("conversationContext")).isEmpty();
            JsonNode followUpContext=requests.get(first+2).path("conversationContext");
            assertThat(followUpContext).hasSize(2);
            assertThat(followUpContext.toString()).contains(firstQuestion).doesNotContain(otherQuestion);

            jdbc.update("UPDATE meeting_participants SET removed_at=CURRENT_TIMESTAMP WHERE meeting_id=? AND user_id=?",
                selected,actor);
            mvc.perform(post(target(own)).principal(principal(actor))
                .header("Idempotency-Key","revoked-"+UUID.randomUUID())
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"question\":\"Hỏi tiếp sau thu hồi quyền\"}"))
                .andExpect(status().isNotFound());
            mvc.perform(get("/api/v1/assistant/conversations/"+own)
                .principal(principal(actor))).andExpect(status().isNotFound());
            mvc.perform(get("/api/v1/assistant/conversations/"+separate)
                .principal(principal(actor))).andExpect(status().isOk());
            assertThat(requests).hasSize(first+3);
        }
        verify(gateway,times(6)).answer(anyString());
        jdbc.update("UPDATE users SET account_status='INACTIVE',deactivated_at=CURRENT_TIMESTAMP WHERE id=?",admin);
        mvc.perform(get("/api/v1/assistant/conversations").principal(principal(admin)))
            .andExpect(status().isUnauthorized());
    }

    @Test void successfulSubmissionIsDurableIdempotentAndScopeBound() throws Exception {
        UUID owner=user(), meeting=meeting(owner),id=conversation(owner,meeting);
        when(gateway.answer(anyString())).thenAnswer(inv->insufficient(inv.getArgument(0)));
        var one=mvc.perform(post(target(id)).principal(principal(owner))
            .header("Idempotency-Key","assistant-key-01")
            .contentType(MediaType.APPLICATION_JSON).content("{\"question\":\"Ai tham gia cuộc họp?\"}"))
            .andExpect(status().isOk()).andReturn();
        JsonNode result=response(one);
        assertThat(result.path("answerStatus").asText()).isEqualTo("INSUFFICIENT_EVIDENCE");
        assertThat(result.path("answer").asText()).contains("Không tìm");
        var replay=mvc.perform(post(target(id)).principal(principal(owner))
            .header("Idempotency-Key","assistant-key-01")
            .contentType(MediaType.APPLICATION_JSON).content("{\"question\":\"Ai tham gia cuộc họp?\"}"))
            .andExpect(status().isOk()).andReturn();
        assertThat(response(replay).path("turnId").asText()).isEqualTo(result.path("turnId").asText());
        JsonNode statusView=response(mvc.perform(get("/api/v1/assistant/conversations/"+id+"/turns/by-key")
            .principal(principal(owner)).header("Idempotency-Key","assistant-key-01"))
            .andExpect(status().isOk()).andReturn());
        assertThat(statusView.path("turn").path("turnId").asText()).isEqualTo(result.path("turnId").asText());
        assertThat(statusView.path("turn").path("state").asText()).isEqualTo("COMPLETED");
        assertThat(statusView.path("recoveryEligible").asBoolean()).isFalse();
        verify(gateway,times(1)).answer(anyString());
        mvc.perform(post(target(id)).principal(principal(owner))
            .header("Idempotency-Key","assistant-key-01")
            .contentType(MediaType.APPLICATION_JSON).content("{\"question\":\"Nội dung khác\"}"))
            .andExpect(status().isConflict());
        assertThat(jdbc.queryForObject("SELECT count(*) FROM assistant_turns WHERE conversation_id=?",Integer.class,id)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM assistant_messages WHERE conversation_id=?",Integer.class,id)).isEqualTo(2);
        var req = org.mockito.ArgumentCaptor.forClass(String.class);
        verify(gateway).answer(req.capture());
        JsonNode sent=json.readTree(req.getValue());
        assertThat(sent.path("authorizedScope").path("allowedMeetingIds")).hasSize(1);
        assertThat(sent.path("authorizedScope").path("allowedMeetingIds").get(0).asText()).isEqualTo(meeting.toString());
        assertThat(sent.path("authorizedScope").path("principalId").asText()).isEqualTo(owner.toString());
    }
    @Test void failureIsPersistedWithoutLeakingProviderExceptionAndRetryCannotDuplicate() throws Exception {
        UUID owner=user(),meeting=meeting(owner),id=conversation(owner,meeting);
        when(gateway.answer(anyString())).thenThrow(new IllegalStateException("private provider token"));
        mvc.perform(post(target(id)).principal(principal(owner))
            .header("Idempotency-Key","assistant-fail-01")
            .contentType(MediaType.APPLICATION_JSON).content("{\"question\":\"Điều gì xảy ra?\"}"))
            .andExpect(status().isServiceUnavailable());
        String history=mvc.perform(get("/api/v1/assistant/conversations/"+id)
            .principal(principal(owner))).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        assertThat(history).contains("FAILED").doesNotContain("private provider token");
        JsonNode failed=response(mvc.perform(get("/api/v1/assistant/conversations/"+id+"/turns/by-key")
            .principal(principal(owner)).header("Idempotency-Key","assistant-fail-01"))
            .andExpect(status().isOk()).andReturn());
        assertThat(failed.path("turn").path("state").asText()).isEqualTo("FAILED");
        assertThat(failed.path("turn").path("answer").isNull()).isTrue();
        assertThat(failed.path("recoveryEligible").asBoolean()).isFalse();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM assistant_turns WHERE conversation_id=? AND state='FAILED'",
            Integer.class,id)).isEqualTo(1);
        mvc.perform(post(target(id)).principal(principal(owner))
            .header("Idempotency-Key","assistant-fail-01")
            .contentType(MediaType.APPLICATION_JSON).content("{\"question\":\"Điều gì xảy ra?\"}"))
            .andExpect(status().isServiceUnavailable());
        verify(gateway,times(1)).answer(anyString());
    }
    @Test void reauthorizationAfterAiWorkPreventsRevokedContentDelivery() throws Exception {
        UUID owner=user(),member=user(),meeting=meeting(owner,member),id=conversation(member,meeting);
        when(gateway.answer(anyString())).thenAnswer(inv->{
            jdbc.update("UPDATE meeting_participants SET removed_at=CURRENT_TIMESTAMP WHERE meeting_id=? AND user_id=?",
                meeting,member);
            return insufficient(inv.getArgument(0));
        });
        mvc.perform(post(target(id)).principal(principal(member))
            .header("Idempotency-Key","revoked-mid-flight")
            .contentType(MediaType.APPLICATION_JSON).content("{\"question\":\"Quyết định?\"}"))
            .andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/assistant/conversations/"+id).principal(principal(member)))
            .andExpect(status().isNotFound());
    }
    @Test void malformedCitationAndFabricatedScopeAreNeverPersistedAsGrounded() throws Exception {
        UUID owner=user(),meeting=meeting(owner),id=conversation(owner,meeting);
        when(gateway.answer(anyString())).thenAnswer(inv->{
            JsonNode req=json.readTree((String)inv.getArgument(0));
            return json.writeValueAsString(Map.of(
                "contractVersion","1.0","requestId",req.path("requestId").asText(),
                "status","GROUNDED","answer","Bịa đặt","scopeId",UUID.randomUUID().toString(),
                "scopeVersion",req.path("authorizedScope").path("scopeVersion").asText(),
                "claims",List.of(),"citations",List.of(),"diagnostics",Map.of(),"failures",List.of()));
        });
        mvc.perform(post(target(id)).principal(principal(owner))
            .header("Idempotency-Key","invented-answer")
            .contentType(MediaType.APPLICATION_JSON).content("{\"question\":\"Mục tiêu?\"}"))
            .andExpect(status().isServiceUnavailable());
        assertThat(jdbc.queryForObject("SELECT count(*) FROM assistant_messages WHERE conversation_id=? AND answer_status='GROUNDED'",
            Integer.class,id)).isZero();
    }
    private String grounded(String requestJson,UUID sourceId,UUID meetingId) throws Exception {
        JsonNode req=json.readTree(requestJson);
        Map<String,Object> identity=Map.of("sourceType","TRANSCRIPT",
            "sourceId",sourceId.toString(),"meetingId",meetingId.toString());
        Map<String,Object> revision=Map.of("number",0);
        Map<String,Object> citation=Map.of(
            "citationId","C1","verificationStatus","AUTHORITATIVELY_VERIFIED",
            "sourceIdentity",identity,"sourceRevision",revision,
            "retrievalChunkId","test-chunk",
            "sourceReferences",List.of(Map.of("sourceIdentity",identity,"sourceRevision",revision)));
        Map<String,Object> body=new java.util.LinkedHashMap<>();
        body.put("contractVersion","1.0");
        body.put("requestId",req.path("requestId").asText());
        body.put("scopeId",req.path("authorizedScope").path("scopeId").asText());
        body.put("scopeVersion",req.path("authorizedScope").path("scopeVersion").asText());
        body.put("status","GROUNDED");
        body.put("answer","Dự án đã được phê duyệt.");
        body.put("claims",List.of(Map.of("claimId","A1","text","Dự án đã được phê duyệt.",
            "support","SUPPORTED","citationIds",List.of("C1"))));
        body.put("citations",List.of(citation));
        body.put("diagnostics",Map.of());
        body.put("modelProvenance",Map.of("provider","test",
            "configuredModel","test-pinned","attempts",1));
        body.put("failures",List.of());
        return json.writeValueAsString(body);
    }

    @Test void sourceRevisionChangeBetweenVerificationAndCommitFailsClosed() throws Exception {
        UUID owner=user(),meeting=meeting(owner),id=conversation(owner,meeting);
        UUID source=UUID.randomUUID();
        // First check validates AI's evidence. The second simulates a newer
        // canonical source revision appearing before the result-acceptance transaction.
        when(sourceVerifier.current("TRANSCRIPT",source,meeting,0L))
            .thenReturn(true,false);
        when(gateway.answer(anyString())).thenAnswer(inv->
            grounded(inv.getArgument(0),source,meeting));
        mvc.perform(post(target(id)).principal(principal(owner))
            .header("Idempotency-Key","source-superseded-at-acceptance")
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"question\":\"Dự án có được duyệt không?\"}"))
            .andExpect(status().isServiceUnavailable());
        verify(sourceVerifier,times(2)).current("TRANSCRIPT",source,meeting,0L);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM assistant_messages
             WHERE conversation_id=? AND answer_status='GROUNDED'
            """,Integer.class,id)).isZero();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM assistant_messages
             WHERE conversation_id=? AND answer_status='FAILED'
            """,Integer.class,id)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM assistant_message_sources s
             JOIN assistant_messages m ON m.id=s.assistant_message_id
            WHERE m.conversation_id=?
            """,Integer.class,id)).isZero();
    }

}
