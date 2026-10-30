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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;

/** Audit write failure must roll back the meeting and initial membership rows. */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class MeetingAuditFailureIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @MockitoSpyBean TransactionalAuditWriter writer;

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
}
