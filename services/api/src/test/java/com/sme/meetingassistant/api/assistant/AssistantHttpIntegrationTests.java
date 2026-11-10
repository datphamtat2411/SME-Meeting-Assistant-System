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

    private UUID user() {
        UUID id=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Assistant actor','test-only','EMPLOYEE','ACTIVE')
            """,id,id+"@test.invalid",id+"@test.invalid");
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
}
