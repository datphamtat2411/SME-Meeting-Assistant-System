package com.sme.meetingassistant.api.meetingintelligence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

/** Safe default: no compatible worker, no misleading pending job or event. */
@ActiveProfiles("test")
@SpringBootTest(properties = {"app.media.outbox.enabled=false",
    "app.media.processing.stage-lease-sweep-ms=3600000",
    "app.meeting-intelligence.regeneration.enabled=false"})
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class SummaryRegenerationDisabledIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Test
    void unavailableWorkerReturns503WithoutQueuingAnything() throws Exception {
        UUID actor=UUID.randomUUID(),meeting=UUID.randomUUID();
        String email="mi08-disabled-"+actor+"@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'MI08 disabled','test-only','EMPLOYEE','ACTIVE')
            """,actor,email,email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Regeneration disabled',?,?)
            """,meeting,actor,actor);
        Principal principal=()->actor.toString();
        int status=mvc.perform(post("/api/v1/meetings/"+meeting+"/summary/regenerate")
            .principal(principal).header("Idempotency-Key","disabled-test"))
            .andReturn().getResponse().getStatus();
        assertThat(status).isEqualTo(503);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM processing_jobs WHERE meeting_id=?",
            Integer.class,meeting)).isZero();
    }
}
