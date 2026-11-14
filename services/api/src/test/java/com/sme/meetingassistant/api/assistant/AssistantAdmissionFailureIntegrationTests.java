package com.sme.meetingassistant.api.assistant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import java.security.Principal;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.server.ResponseStatusException;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import tools.jackson.databind.ObjectMapper;

/** Admission persistence failure is safe, canonical 503, and pre-inference. */
@ActiveProfiles("test")
@SpringBootTest(properties={"app.assistant.enabled=true","app.media.outbox.enabled=false"})
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class AssistantAdmissionFailureIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @MockitoBean AssistantAdmissionGuard admission;
    @MockitoBean AssistantAiGateway gateway;
    @MockitoBean AssistantSourceVerifier sourceVerifier;

    @Test
    void admissionDatabaseFailureReturns503AndDoesNotCallAi() throws Exception {
        UUID owner = user();
        UUID meeting = meeting(owner);
        UUID conversation = conversation(owner, meeting);
        doThrow(new DataAccessResourceFailureException("database unavailable"))
            .when(admission).lockAskScope(any(UUID.class), any(UUID.class));
        when(admission.databaseUnavailable()).thenReturn(
            new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE));

        MvcResult result = mvc.perform(post("/api/v1/assistant/conversations/" + conversation + "/messages")
            .principal(principal(owner)).header("Idempotency-Key", "admission-db-failure")
            .contentType(MediaType.APPLICATION_JSON).content("{\"question\":\"Will this run?\"}"))
            .andReturn();

        assertThat(result.getResponse().getStatus()).isEqualTo(503);
        assertThat(json.readTree(result.getResponse().getContentAsString()).path("code").asText())
            .isEqualTo("INTERNAL_SERVICE_UNAVAILABLE");
        assertThat(result.getResponse().getContentAsString()).doesNotContain("database unavailable", "SQL");
        assertThat(jdbc.queryForObject("SELECT count(*) FROM assistant_turns WHERE conversation_id=?",
            Long.class, conversation)).isZero();
        verify(admission).databaseUnavailable();
        verifyNoInteractions(gateway);
    }

    private UUID user() {
        UUID id=UUID.randomUUID();
        String email=id+"@assistant-admission-failure.test";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Admission failure actor','test-only','EMPLOYEE','ACTIVE')
            """,id,email,email);
        return id;
    }

    private UUID meeting(UUID owner) {
        UUID id=UUID.randomUUID();
        jdbc.update("INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id) VALUES (?,'Failure test',?,?)",
            id,owner,owner);
        return id;
    }

    private UUID conversation(UUID owner,UUID meeting) {
        UUID id=UUID.randomUUID();
        jdbc.update("INSERT INTO assistant_conversations(id,user_id,meeting_id,title) VALUES (?,?,?,'Failure fixture')",
            id,owner,meeting);
        return id;
    }

    private static Principal principal(UUID id) { return () -> id.toString(); }
}
