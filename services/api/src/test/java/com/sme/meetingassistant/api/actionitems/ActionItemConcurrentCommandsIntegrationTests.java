package com.sme.meetingassistant.api.actionitems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * CI tests use separate PostgreSQL connections and independent HTTP requests.
 * Deliberately NOT @Transactional: a shared test transaction conceals races.
 */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class ActionItemConcurrentCommandsIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;

    private UUID organizer;
    private UUID meeting;

    @BeforeEach void seed() {
        organizer=UUID.randomUUID();
        meeting=UUID.randomUUID();
        String email="ai05-race-"+organizer+"@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Action Item concurrency','test-only','EMPLOYEE','ACTIVE')
            """,organizer,email,email);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'AI05 concurrency',?,?)
            """,meeting,organizer,organizer);
    }

    private Principal principal() { return () -> organizer.toString(); }

    private MvcResult create(String key, String title) throws Exception {
        String body=json.writeValueAsString(Map.of("meetingId",meeting,"title",title,
            "assigneeUserId",organizer));
        var request=post("/api/v1/action-items").principal(principal())
            .contentType(MediaType.APPLICATION_JSON).content(body);
        if(key!=null) request.header("Idempotency-Key",key);
        return mvc.perform(request).andReturn();
    }

    private UUID itemId(MvcResult result) throws Exception {
        JsonNode parsed=json.readTree(result.getResponse().getContentAsString());
        return UUID.fromString(parsed.path("data").path("id").asText());
    }

    @Test
    void concurrentSameKeyPostHasOneCanonicalItemAndOneHistorySet() throws Exception {
        String key="ai05-concurrent-"+UUID.randomUUID();
        ExecutorService pool=Executors.newFixedThreadPool(2);
        CountDownLatch ready=new CountDownLatch(2), start=new CountDownLatch(1);
        try {
            Callable<MvcResult> send=() -> {
                ready.countDown();
                if (!start.await(15,TimeUnit.SECONDS)) throw new AssertionError("Start timeout");
                return create(key,"Same logical creation");
            };
            Future<MvcResult> a=pool.submit(send),b=pool.submit(send);
            assertThat(ready.await(15,TimeUnit.SECONDS)).isTrue();
            start.countDown();
            MvcResult r1=a.get(50,TimeUnit.SECONDS),r2=b.get(50,TimeUnit.SECONDS);
            assertThat(List.of(r1.getResponse().getStatus(),r2.getResponse().getStatus()))
                .containsExactlyInAnyOrder(201,201);
            UUID first=itemId(r1),second=itemId(r2);
            assertThat(first).isEqualTo(second);
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM action_items WHERE meeting_id=?",
                Integer.class,meeting)).isEqualTo(1);
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM action_item_history WHERE action_item_id=?",
                Integer.class,first)).isEqualTo(2);
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM action_item_creation_idempotency WHERE actor_user_id=?",
                Integer.class,organizer)).isEqualTo(1);
        } finally {
            start.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void simultaneousPatchesWithSameEtagCannotLoseChangesOrDuplicateHistory()
            throws Exception {
        MvcResult created=create(null,"Original");
        assertThat(created.getResponse().getStatus()).isEqualTo(201);
        UUID id=itemId(created);
        String tag=created.getResponse().getHeader(HttpHeaders.ETAG);
        ExecutorService pool=Executors.newFixedThreadPool(2);
        CountDownLatch ready=new CountDownLatch(2),start=new CountDownLatch(1);
        try {
            Callable<MvcResult> a=patchCall(id,tag,"Title from A",ready,start);
            Callable<MvcResult> b=patchCall(id,tag,"Title from B",ready,start);
            Future<MvcResult> first=pool.submit(a),second=pool.submit(b);
            assertThat(ready.await(15,TimeUnit.SECONDS)).isTrue();
            start.countDown();
            MvcResult r1=first.get(50,TimeUnit.SECONDS),r2=second.get(50,TimeUnit.SECONDS);
            assertThat(List.of(r1.getResponse().getStatus(),r2.getResponse().getStatus()))
                .containsExactlyInAnyOrder(200,412);
            assertThat(jdbc.queryForObject("SELECT title FROM action_items WHERE id=?",
                String.class,id)).isIn("Title from A","Title from B");
            assertThat(jdbc.queryForObject("SELECT version FROM action_items WHERE id=?",
                Long.class,id)).isEqualTo(1L);
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM action_item_history WHERE action_item_id=? AND change_type='CONTENT'",
                Integer.class,id)).isEqualTo(1);
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM action_item_history WHERE action_item_id=?",
                Integer.class,id)).isEqualTo(3);
        } finally {
            start.countDown();
            pool.shutdownNow();
        }
    }

    private Callable<MvcResult> patchCall(UUID id,String tag,String title,
            CountDownLatch ready,CountDownLatch start) {
        return () -> {
            ready.countDown();
            if(!start.await(15,TimeUnit.SECONDS))throw new AssertionError("Start timeout");
            return mvc.perform(patch("/api/v1/action-items/{id}",id)
                .principal(principal()).header(HttpHeaders.IF_MATCH,tag)
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("title",title)))).andReturn();
        };
    }
}
