package com.sme.meetingassistant.api.actionitems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.actionitem.service.ActionItemBatchFingerprint;
import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink;
import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink.Batch;
import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink.Candidate;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.Principal;
import java.sql.Connection;
import java.time.LocalDate;
import java.util.HexFormat;
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
    @Autowired ActionItemProposalSink sink;

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

    @Test
    void simultaneousCompleteAndCancelWithSameEtagHaveOneWinner() throws Exception {
        MvcResult created=create(null,"Competing lifecycle commands");
        assertThat(created.getResponse().getStatus()).isEqualTo(201);
        UUID id=itemId(created);
        String tag=created.getResponse().getHeader(HttpHeaders.ETAG);
        ExecutorService pool=Executors.newFixedThreadPool(2);
        CountDownLatch ready=new CountDownLatch(2),start=new CountDownLatch(1);
        try {
            Future<MvcResult> complete=pool.submit(commandCall(id,tag,"complete",ready,start));
            Future<MvcResult> cancel=pool.submit(commandCall(id,tag,"cancel",ready,start));
            assertThat(ready.await(15,TimeUnit.SECONDS)).isTrue();
            start.countDown();
            assertThat(List.of(complete.get(50,TimeUnit.SECONDS).getResponse().getStatus(),
                cancel.get(50,TimeUnit.SECONDS).getResponse().getStatus()))
                .containsExactlyInAnyOrder(200,412);
            assertThat(jdbc.queryForObject("SELECT status FROM action_items WHERE id=?",
                String.class,id)).isIn("DONE","CANCELLED");
            assertThat(jdbc.queryForObject("SELECT version FROM action_items WHERE id=?",
                Long.class,id)).isEqualTo(1L);
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM action_item_history WHERE action_item_id=?",
                Integer.class,id)).isEqualTo(3);
            assertThat(jdbc.queryForObject(
                "SELECT count(*) FROM action_item_assignment_revocations WHERE action_item_id=?",
                Integer.class,id)).isEqualTo(1);
        } finally {
            start.countDown();
            pool.shutdownNow();
        }
    }


    @Test
    void managerScopeRevokedWhileCommandWaitsForRowLockCannotCancel() throws Exception {
        UUID unit=UUID.randomUUID(), manager=UUID.randomUUID();
        jdbc.update("INSERT INTO organizational_units(id,code,name,status) VALUES (?,?,?,'ACTIVE')",
            unit,"AI-RACE-"+unit,"Race scope");
        insertUser(manager,"DEPARTMENT_MANAGER");
        jdbc.update("INSERT INTO manager_scope_units(user_id,org_unit_id,granted_by_user_id) VALUES (?,?,?)",
            manager,unit,organizer);
        jdbc.update("INSERT INTO meeting_action_item_scopes(meeting_id,org_unit_id,recorded_by_user_id) VALUES (?,?,?)",
            meeting,unit,organizer);
        MvcResult created=create(null,"Scope revocation race");
        assertThat(created.getResponse().getStatus()).isEqualTo(201);
        UUID id=itemId(created);
        String tag=created.getResponse().getHeader(HttpHeaders.ETAG);
        MvcResult before=mvc.perform(get("/api/v1/action-items/{id}",id)
            .principal(() -> manager.toString())).andReturn();
        assertThat(before.getResponse().getStatus()).isEqualTo(200);
        assertThat(json.readTree(before.getResponse().getContentAsString())
            .path("data").path("capabilities").path("canCancel").asBoolean()).isTrue();
        MvcResult result=whileItemLocked(id, () -> mvc.perform(
            post("/api/v1/action-items/{id}/cancel",id)
                .principal(() -> manager.toString()).header(HttpHeaders.IF_MATCH,tag)).andReturn(),
            () -> jdbc.update("DELETE FROM manager_scope_units WHERE user_id=? AND org_unit_id=?",manager,unit));
        assertThat(result.getResponse().getStatus()).isEqualTo(404);
        assertUnchangedOpenItem(id);
    }

    @Test
    void assigneeDeactivatedWhileCommandWaitsForRowLockCannotComplete() throws Exception {
        UUID assignee=UUID.randomUUID();
        insertUser(assignee,"EMPLOYEE");
        MvcResult created=createFor(organizer,assignee,null,"Assignee deactivation race");
        assertThat(created.getResponse().getStatus()).isEqualTo(201);
        UUID id=itemId(created);
        String tag=created.getResponse().getHeader(HttpHeaders.ETAG);
        assertThat(json.readTree(created.getResponse().getContentAsString())
            .path("data").path("capabilities").path("canComplete").asBoolean()).isTrue();
        MvcResult result=whileItemLocked(id, () -> mvc.perform(
            post("/api/v1/action-items/{id}/complete",id)
                .principal(principal()).header(HttpHeaders.IF_MATCH,tag)).andReturn(),
            () -> jdbc.update("UPDATE users SET account_status='INACTIVE' WHERE id=?",assignee));
        assertThat(result.getResponse().getStatus()).isEqualTo(422);
        assertUnchangedOpenItem(id);
    }

    @Test
    void actorDeactivatedWhileCreationWaitsForIdempotencyClaimCannotCreate() throws Exception {
        UUID assignee=UUID.randomUUID();
        insertUser(assignee,"EMPLOYEE");
        String key="ai05-deactivation-"+UUID.randomUUID();
        String digest=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
            .digest(("POST /api/v1/action-items\n"+key).getBytes(StandardCharsets.UTF_8)));
        ExecutorService pool=Executors.newSingleThreadExecutor();
        try (Connection claim=jdbc.getDataSource().getConnection()) {
            claim.setAutoCommit(false);
            int blocker=backendPid(claim);
            try {
                // Reserve the unique key in a competing transaction; roll back
                // after revocation so a prior successful item cannot mask a write.
                try (var stmt=claim.prepareStatement("""
                    INSERT INTO action_item_creation_idempotency
                        (actor_user_id,key_digest,request_digest,expires_at)
                    VALUES (?,?,?,clock_timestamp()+INTERVAL '24 hours')
                    """)) {
                    stmt.setObject(1,organizer);
                    stmt.setString(2,digest);
                    stmt.setString(3,"a".repeat(64));
                    stmt.executeUpdate();
                }
                Future<MvcResult> request=pool.submit(() ->
                    createFor(organizer,assignee,key,"Revoked creation"));
                awaitBlockedBy(blocker,request);
                jdbc.update("UPDATE users SET account_status='INACTIVE' WHERE id=?",organizer);
                claim.rollback();
                assertThat(request.get(50,TimeUnit.SECONDS).getResponse().getStatus()).isEqualTo(401);
                assertThat(jdbc.queryForObject("SELECT count(*) FROM action_items WHERE meeting_id=?",
                    Integer.class,meeting)).isZero();
                assertThat(jdbc.queryForObject(
                    "SELECT count(*) FROM action_item_creation_idempotency WHERE actor_user_id=?",
                    Integer.class,organizer)).isZero();
            } finally {
                claim.rollback();
            }
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void simultaneousConfirmCommandsProduceOneOfficialAssignment() throws Exception {
        UUID id=createAiProposal();
        MvcResult initial=mvc.perform(get("/api/v1/action-items/{id}",id)
            .principal(principal())).andReturn();
        assertThat(initial.getResponse().getStatus()).isEqualTo(200);
        MvcResult assigned=mvc.perform(patch("/api/v1/action-items/{id}",id)
            .principal(principal()).header(HttpHeaders.IF_MATCH,initial.getResponse().getHeader(HttpHeaders.ETAG))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("assigneeUserId",organizer)))).andReturn();
        assertThat(assigned.getResponse().getStatus()).isEqualTo(200);
        String tag=assigned.getResponse().getHeader(HttpHeaders.ETAG);
        long version=jdbc.queryForObject("SELECT version FROM action_items WHERE id=?",Long.class,id);
        int history=jdbc.queryForObject("SELECT count(*) FROM action_item_history WHERE action_item_id=?",
            Integer.class,id);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM action_item_assignment_events WHERE action_item_id=?",
            Integer.class,id)).isZero();
        ExecutorService pool=Executors.newFixedThreadPool(2);
        CountDownLatch ready=new CountDownLatch(2),start=new CountDownLatch(1);
        try {
            Future<MvcResult> a=pool.submit(commandCall(id,tag,"confirm",ready,start));
            Future<MvcResult> b=pool.submit(commandCall(id,tag,"confirm",ready,start));
            assertThat(ready.await(15,TimeUnit.SECONDS)).isTrue();
            start.countDown();
            assertThat(List.of(a.get(50,TimeUnit.SECONDS).getResponse().getStatus(),
                b.get(50,TimeUnit.SECONDS).getResponse().getStatus())).containsExactlyInAnyOrder(200,412);
            assertThat(jdbc.queryForObject("SELECT status FROM action_items WHERE id=?",String.class,id))
                .isEqualTo("OPEN");
            assertThat(jdbc.queryForObject("SELECT version FROM action_items WHERE id=?",Long.class,id))
                .isEqualTo(version+1);
            assertThat(jdbc.queryForObject("SELECT count(*) FROM action_item_history WHERE action_item_id=?",
                Integer.class,id)).isEqualTo(history+1);
            assertThat(jdbc.queryForObject("SELECT count(*) FROM action_item_assignment_events WHERE action_item_id=?",
                Integer.class,id)).isEqualTo(1);
        } finally {
            start.countDown();
            pool.shutdownNow();
        }
    }

    private void insertUser(UUID id,String role) {
        String email="ai05-race-"+id+"@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Action Item concurrency','test-only',?,'ACTIVE')
            """,id,email,email,role);
    }

    private MvcResult createFor(UUID actor,UUID assignee,String key,String title) throws Exception {
        String body=json.writeValueAsString(Map.of("meetingId",meeting,"title",title,"assigneeUserId",assignee));
        var request=post("/api/v1/action-items").principal(() -> actor.toString())
            .contentType(MediaType.APPLICATION_JSON).content(body);
        if(key!=null) request.header("Idempotency-Key",key);
        return mvc.perform(request).andReturn();
    }

    private MvcResult whileItemLocked(UUID id,Callable<MvcResult> send,Runnable revoke) throws Exception {
        ExecutorService pool=Executors.newSingleThreadExecutor();
        try (Connection lock=jdbc.getDataSource().getConnection()) {
            lock.setAutoCommit(false);
            int blocker=backendPid(lock);
            try {
                try (var stmt=lock.prepareStatement("SELECT id FROM action_items WHERE id=? FOR UPDATE")) {
                    stmt.setObject(1,id);
                    try (var rows=stmt.executeQuery()) {
                        assertThat(rows.next()).isTrue();
                    }
                }
                Future<MvcResult> request=pool.submit(send);
                awaitBlockedBy(blocker,request);
                revoke.run();
                lock.commit();
                return request.get(50,TimeUnit.SECONDS);
            } finally {
                lock.rollback();
            }
        } finally {
            pool.shutdownNow();
        }
    }

    private int backendPid(Connection connection) throws Exception {
        try (var stmt=connection.createStatement(); var rows=stmt.executeQuery("SELECT pg_backend_pid()")) {
            assertThat(rows.next()).isTrue();
            return rows.getInt(1);
        }
    }

    // Poll the actual database lock graph, not a guessed delay.
    private void awaitBlockedBy(int blocker,Future<MvcResult> request) throws Exception {
        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);
        while(System.nanoTime()<deadline) {
            if(Boolean.TRUE.equals(jdbc.queryForObject("""
                SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                    WHERE ? = ANY(pg_blocking_pids(pid)))
                """,Boolean.class,blocker))) return;
            if(request.isDone()) {
                throw new AssertionError("Request completed before waiting on the held lock: "
                    +request.get().getResponse().getStatus());
            }
            Thread.sleep(25);
        }
        throw new AssertionError("HTTP transaction did not wait on PostgreSQL backend "+blocker);
    }

    private void assertUnchangedOpenItem(UUID id) {
        assertThat(jdbc.queryForObject("SELECT status FROM action_items WHERE id=?",String.class,id)).isEqualTo("OPEN");
        assertThat(jdbc.queryForObject("SELECT version FROM action_items WHERE id=?",Long.class,id)).isZero();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM action_item_history WHERE action_item_id=?",
            Integer.class,id)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM action_item_assignment_revocations WHERE action_item_id=?",
            Integer.class,id)).isZero();
    }

    private UUID createAiProposal() throws Exception {
        UUID media=UUID.randomUUID(), job=UUID.randomUUID(), transcript=UUID.randomUUID();
        UUID segment=UUID.randomUUID(), snapshot=UUID.randomUUID(), stage=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,10000,?,CURRENT_TIMESTAMP)
            """,media,meeting,"meetings/"+meeting+"/sources/"+media,
            "meetings/"+meeting+"/pending/"+media,organizer);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status)
            VALUES (?,?,?,?,'RUNNING')
            """,job,meeting,media,organizer);
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,version_number,
                language_code,status,is_current,content_revision)
            VALUES (?,?,?,?,1,'vi','READY',TRUE,3)
            """,transcript,meeting,media,job);
        jdbc.update("""
            INSERT INTO transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,current_text,quality_status)
            VALUES (?,?,0,0,1000,'AI proposal evidence','ACCEPTED')
            """,segment,transcript);
        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(
                id,meeting_id,source_media_id,processing_job_id,transcript_id,
                content_revision,sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,3,?,?,100)
            """,snapshot,meeting,media,job,transcript,"a".repeat(64),
            "processing/"+job+"/intelligence/source/"+snapshot+".json");
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,
                attempt_number,status,claim_token,lease_expires_at)
            VALUES (?,?,'EXTRACTING_ACTION_ITEMS',1,'RUNNING',?,CURRENT_TIMESTAMP+INTERVAL '1 hour')
            """,stage,job,UUID.randomUUID());
        List<Candidate> candidates=List.of(new Candidate("task-1","Gửi báo cáo quý",
            "Chờ người tổ chức xác nhận",LocalDate.parse("2026-11-08"),List.of(segment)));
        Batch batch=new Batch(meeting,job,stage,snapshot,transcript,3,false,
            ActionItemBatchFingerprint.sha256(json,candidates),candidates);
        assertThat(sink.acceptProposed(batch).newProposals()).isEqualTo(1);
        return jdbc.queryForObject("SELECT id FROM action_items WHERE proposal_batch_id=("
            + "SELECT id FROM action_item_batch_receipts WHERE stage_run_id=?)",UUID.class,stage);
    }

    private Callable<MvcResult> commandCall(UUID id,String tag,String command,
            CountDownLatch ready,CountDownLatch start) {
        return () -> {
            ready.countDown();
            if(!start.await(15,TimeUnit.SECONDS))throw new AssertionError("Start timeout");
            return mvc.perform(post("/api/v1/action-items/{id}/"+command,id)
                .principal(principal()).header(HttpHeaders.IF_MATCH,tag)).andReturn();
        };
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
