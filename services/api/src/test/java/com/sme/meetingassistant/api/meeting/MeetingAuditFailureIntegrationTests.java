package com.sme.meetingassistant.api.meeting;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.doThrow;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.audit.TransactionalAuditWriter;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.http.HttpHeaders;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

/** Audit write failure must roll back the meeting and initial membership rows. */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class MeetingAuditFailureIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @MockitoBean TransactionalAuditWriter writer;

    @Test void failedAuditInsertPreventsMeetingCommit() throws Exception {
        UUID actor = UUID.randomUUID();
        String email = "audit-failure-" + actor + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Audit rollback','test-only','EMPLOYEE','ACTIVE')
            """,actor,email,email);
        doThrow(new IllegalStateException("injected audit failure"))
            .when(writer).record(eq(actor),eq("MEETING_CREATED"),eq("MEETING"),
                any(UUID.class),any(UUID.class),anyMap());

        Principal principal = () -> actor.toString();
        mvc.perform(post("/api/v1/meetings").principal(principal)
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"title\":\"Must roll back\"}"))
            .andExpect(status().isInternalServerError());
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meetings WHERE created_by_user_id=?
            """,Integer.class,actor)).isZero();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_participants WHERE added_by_user_id=?
            """,Integer.class,actor)).isZero();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM audit_events WHERE actor_user_id=?
                AND action_code LIKE 'MEETING_%'
            """,Integer.class,actor)).isZero();
    }

    @Test void failedScheduleAuditRollsBackReservationAndEmailIntent() throws Exception {
        UUID actor = UUID.randomUUID();
        String email = "audit-schedule-failure-" + actor + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Audit rollback','test-only','EMPLOYEE','ACTIVE')
            """,actor,email,email);
        UUID room = UUID.randomUUID();
        jdbc.update("INSERT INTO rooms(id,code,name) VALUES (?,?,?)",
            room,"AUDIT-" + room,"Failure test room");
        Principal principal = () -> actor.toString();
        String payload = json.writeValueAsString(java.util.Map.of(
            "title","Must keep draft", "roomId", room,
            "scheduledStartAt","2030-11-03T09:00:00Z",
            "scheduledEndAt","2030-11-03T10:00:00Z"));
        MvcResult created = mvc.perform(post("/api/v1/meetings").principal(principal)
            .contentType(MediaType.APPLICATION_JSON).content(payload))
            .andExpect(status().isCreated()).andReturn();
        UUID meeting = UUID.fromString(json.readTree(created.getResponse().getContentAsString())
            .path("data").path("id").asText());
        doThrow(new IllegalStateException("injected schedule audit failure"))
            .when(writer).record(eq(actor),eq("MEETING_SCHEDULED"),eq("MEETING"),
                eq(meeting),eq(meeting),anyMap());
        mvc.perform(post("/api/v1/meetings/" + meeting + "/schedule")
            .principal(principal)
            .header(HttpHeaders.IF_MATCH,created.getResponse().getHeader(HttpHeaders.ETAG)))
            .andExpect(status().isInternalServerError());
        assertThat(jdbc.queryForObject("SELECT status FROM meetings WHERE id=?",
            String.class,meeting)).isEqualTo("DRAFT");
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM room_reservations WHERE meeting_id=?",
            Integer.class,meeting)).isZero();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries WHERE related_entity_id=?
                AND notification_type='MEETING_SCHEDULED'
            """,Integer.class,meeting)).isZero();
    }
}
