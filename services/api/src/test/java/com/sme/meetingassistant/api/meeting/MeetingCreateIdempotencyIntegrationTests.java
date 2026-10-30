package com.sme.meetingassistant.api.meeting;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
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
 * T02 integration evidence: independent committed HTTP requests and real
 * PostgreSQL uniqueness, including simultaneous retries from separate threads.
 */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class MeetingCreateIdempotencyIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;

    UUID organizer, other, participant;

    @BeforeEach void fixture() {
        organizer = activeUser();
        other = activeUser();
        participant = activeUser();
    }

    private UUID activeUser() {
        UUID id = UUID.randomUUID();
        String email = "idem-" + id + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Idempotency test user','test-only','EMPLOYEE','ACTIVE')
            """, id,email,email);
        return id;
    }

    private static Principal principal(UUID id) {
        return () -> id.toString();
    }

    private MvcResult create(UUID actor, String key, Object payload) throws Exception {
        var req = post("/api/v1/meetings")
            .principal(principal(actor)).contentType(MediaType.APPLICATION_JSON)
            .content(payload instanceof String s ? s : json.writeValueAsString(payload));
        if (key != null) req.header("Idempotency-Key",key);
        return mvc.perform(req).andReturn();
    }

    private UUID id(MvcResult response) throws Exception {
        return UUID.fromString(json.readTree(response.getResponse().getContentAsString())
            .path("data").path("id").asText());
    }

    private String field(MvcResult result, String name) throws Exception {
        return json.readTree(result.getResponse().getContentAsString())
            .path("data").path(name).asText();
    }

    private int meetings(UUID owner) {
        return jdbc.queryForObject("SELECT count(*) FROM meetings WHERE created_by_user_id=?",
            Integer.class,owner);
    }

    private int audits(UUID meetingId) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM audit_events
            WHERE meeting_id=? AND action_code='MEETING_CREATED'
            """,Integer.class,meetingId);
    }

    private int participants(UUID meetingId) {
        return jdbc.queryForObject(
            "SELECT count(*) FROM meeting_participants WHERE meeting_id=?",
            Integer.class,meetingId);
    }

    @Test void sameKeySameIntentReplaysExistingMeetingWithNoDuplicateSideEffects() throws Exception {
        Map<String,Object> request = Map.of("title"," Review ","description"," A note ",
            "scheduledStartAt","2030-11-12T09:00:00Z",
            "scheduledEndAt","2030-11-12T10:00:00Z",
            "participantUserIds",List.of(participant));
        MvcResult original = create(organizer,"create-42",request);
        assertThat(original.getResponse().getStatus()).isEqualTo(201);
        MvcResult replay = create(organizer,"create-42",Map.of(
            "title","Review","description","A note",
            "scheduledStartAt","2030-11-12T16:00:00+07:00",
            "scheduledEndAt","2030-11-12T17:00:00+07:00",
            "participantUserIds",List.of(participant)));
        assertThat(replay.getResponse().getStatus()).isEqualTo(201);
        assertThat(id(replay)).isEqualTo(id(original));
        assertThat(replay.getResponse().getHeader(HttpHeaders.LOCATION))
            .isEqualTo(original.getResponse().getHeader(HttpHeaders.LOCATION));
        assertThat(replay.getResponse().getHeader(HttpHeaders.ETAG))
            .isEqualTo(original.getResponse().getHeader(HttpHeaders.ETAG));
        assertThat(meetings(organizer)).isEqualTo(1);
        assertThat(participants(id(original))).isEqualTo(2);
        assertThat(audits(id(original))).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_creation_idempotency
            WHERE actor_user_id=? AND meeting_id=?
            """,Integer.class,organizer,id(original))).isEqualTo(1);
        Map<String,Object> hashes=jdbc.queryForMap("""
            SELECT key_digest,request_digest FROM meeting_creation_idempotency
            WHERE actor_user_id=?
            """,organizer);
        assertThat(hashes.get("key_digest").toString().trim()).hasSize(64).isNotEqualTo("create-42");
        assertThat(hashes.get("request_digest").toString().trim()).hasSize(64);
    }

    @Test void reusedKeyWithDifferentIntentIs409AndCannotCreateAnotherMeeting() throws Exception {
        MvcResult first = create(organizer,"same-key",Map.of("title","First"));
        assertThat(first.getResponse().getStatus()).isEqualTo(201);
        MvcResult incompatible = create(organizer,"same-key",Map.of("title","Different"));
        assertThat(incompatible.getResponse().getStatus()).isEqualTo(409);
        assertThat(meetings(organizer)).isEqualTo(1);
        assertThat(audits(id(first))).isEqualTo(1);
    }

    @Test void keysAreScopedPerAuthenticatedCallerAndAbsentKeyPreservesLegacySemantics()
            throws Exception {
        Map<String,Object> payload=Map.of("title","Independent");
        MvcResult a = create(organizer,"shared-key",payload);
        MvcResult b = create(other,"shared-key",payload);
        assertThat(a.getResponse().getStatus()).isEqualTo(201);
        assertThat(b.getResponse().getStatus()).isEqualTo(201);
        assertThat(id(a)).isNotEqualTo(id(b));
        MvcResult noKey = create(organizer,null,payload);
        MvcResult secondNoKey = create(organizer,null,payload);
        assertThat(id(noKey)).isNotEqualTo(id(secondNoKey));
        assertThat(meetings(organizer)).isEqualTo(3);
        assertThat(meetings(other)).isEqualTo(1);
    }

    @Test void invalidOrFailedCreateDoesNotConsumeKey() throws Exception {
        for(String badKey:List.of("bad key","!invalid","a".repeat(129),"bad,value")) {
            MvcResult invalid = create(organizer,badKey,Map.of("title","Rejected"));
            assertThat(invalid.getResponse().getStatus()).isEqualTo(400);
        }
        UUID unknownRoom=UUID.randomUUID();
        MvcResult badRoom=create(organizer,"reusable",Map.of(
            "title","Room not found","roomId",unknownRoom));
        assertThat(badRoom.getResponse().getStatus()).isEqualTo(404);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_creation_idempotency WHERE actor_user_id=?
            """,Integer.class,organizer)).isZero();
        MvcResult good=create(organizer,"reusable",Map.of("title","Valid after rollback"));
        assertThat(good.getResponse().getStatus()).isEqualTo(201);
        assertThat(meetings(organizer)).isEqualTo(1);
    }

    @Test void replayStillRequiresActiveActorAndReturnsCurrentResourceNotStaleSnapshot()
            throws Exception {
        MvcResult first=create(organizer,"retry-current",Map.of("title","Initial"));
        UUID meeting=id(first);
        MvcResult patched=mvc.perform(patch("/api/v1/meetings/" + meeting)
            .principal(principal(organizer))
            .header(HttpHeaders.IF_MATCH,first.getResponse().getHeader(HttpHeaders.ETAG))
            .contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"Updated\"}"))
            .andExpect(status().isOk()).andReturn();
        MvcResult retry=create(organizer,"retry-current",Map.of("title","Initial"));
        assertThat(retry.getResponse().getStatus()).isEqualTo(201);
        assertThat(id(retry)).isEqualTo(meeting);
        assertThat(field(retry,"title")).isEqualTo("Updated");
        assertThat(retry.getResponse().getHeader(HttpHeaders.ETAG))
            .isEqualTo(patched.getResponse().getHeader(HttpHeaders.ETAG));
        assertThat(audits(meeting)).isEqualTo(1);
        jdbc.update("UPDATE users SET account_status='INACTIVE',deactivated_at=CURRENT_TIMESTAMP WHERE id=?",
            organizer);
        MvcResult denied=create(organizer,"retry-current",Map.of("title","Initial"));
        assertThat(denied.getResponse().getStatus()).isEqualTo(401);
        assertThat(meetings(organizer)).isEqualTo(1);
    }

    @Test void expirationAllowsNewIntentAndCleanupDoesNotRemoveUnexpiredRecords()
            throws Exception {
        MvcResult first=create(organizer,"expiring",Map.of("title","Old"));
        assertThat(first.getResponse().getStatus()).isEqualTo(201);
        jdbc.update("""
            UPDATE meeting_creation_idempotency SET expires_at=CURRENT_TIMESTAMP - INTERVAL '1 second'
            WHERE actor_user_id=?
            """,organizer);
        MvcResult after=create(organizer,"expiring",Map.of("title","New"));
        assertThat(after.getResponse().getStatus()).isEqualTo(201);
        assertThat(id(after)).isNotEqualTo(id(first));
        assertThat(meetings(organizer)).isEqualTo(2);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_creation_idempotency WHERE actor_user_id=?
            """,Integer.class,organizer)).isEqualTo(1);
    }

    @Test @Timeout(60)
    void simultaneousSameKeyCreatesExactlyOneMeetingAcrossCommittedHttpTransactions()
            throws Exception {
        Map<String,Object> payload=Map.of("title","Concurrent create",
            "participantUserIds",List.of(participant));
        var pool=Executors.newFixedThreadPool(2);
        CountDownLatch ready=new CountDownLatch(2), start=new CountDownLatch(1);
        try {
            java.util.concurrent.Callable<MvcResult> task=() -> {
                ready.countDown();
                if(!start.await(15,TimeUnit.SECONDS)) throw new IllegalStateException("start timeout");
                return create(organizer,"simultaneous",payload);
            };
            var a=pool.submit(task);
            var b=pool.submit(task);
            assertThat(ready.await(15,TimeUnit.SECONDS)).isTrue();
            start.countDown();
            MvcResult first=a.get(45,TimeUnit.SECONDS);
            MvcResult second=b.get(45,TimeUnit.SECONDS);
            assertThat(first.getResponse().getStatus()).isEqualTo(201);
            assertThat(second.getResponse().getStatus()).isEqualTo(201);
            assertThat(id(first)).isEqualTo(id(second));
            assertThat(meetings(organizer)).isEqualTo(1);
            assertThat(participants(id(first))).isEqualTo(2);
            assertThat(audits(id(first))).isEqualTo(1);
        } finally {
            start.countDown();
            pool.shutdownNow();
        }
    }

    @Test @Timeout(60)
    void simultaneousDifferentIntentsWithOneKeyYieldOneCreateAndOneConflict()
            throws Exception {
        var pool=Executors.newFixedThreadPool(2);
        CountDownLatch ready=new CountDownLatch(2), start=new CountDownLatch(1);
        try {
            java.util.concurrent.Callable<MvcResult> first=() -> {
                ready.countDown(); start.await(15,TimeUnit.SECONDS);
                return create(organizer,"race-conflict",Map.of("title","One"));
            };
            java.util.concurrent.Callable<MvcResult> second=() -> {
                ready.countDown(); start.await(15,TimeUnit.SECONDS);
                return create(organizer,"race-conflict",Map.of("title","Two"));
            };
            var a=pool.submit(first);
            var b=pool.submit(second);
            assertThat(ready.await(15,TimeUnit.SECONDS)).isTrue();
            start.countDown();
            int x=a.get(45,TimeUnit.SECONDS).getResponse().getStatus();
            int y=b.get(45,TimeUnit.SECONDS).getResponse().getStatus();
            assertThat(List.of(x,y)).containsExactlyInAnyOrder(201,409);
            assertThat(meetings(organizer)).isEqualTo(1);
        } finally {
            start.countDown();
            pool.shutdownNow();
        }
    }
}
