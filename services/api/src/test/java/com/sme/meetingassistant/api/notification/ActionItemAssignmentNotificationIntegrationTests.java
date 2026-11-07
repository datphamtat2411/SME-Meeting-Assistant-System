package com.sme.meetingassistant.api.notification;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.actionitem.service.ActionItemBatchFingerprint;
import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink;
import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink.Batch;
import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink.Candidate;
import com.sme.meetingassistant.api.actionitems.ActionItemService;
import com.sme.meetingassistant.api.actionitems.dto.CreateActionItemRequest;
import com.sme.meetingassistant.api.notification.email.TransactionalEmailHandler;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
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
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.dao.DataIntegrityViolationException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * AI-08.3 real PostgreSQL and MockMvc integration on independent HTTP transactions.
 * Only the durable email intent is enabled; the legacy unsafe outbound renderer
 * stays unregistered until AI-08.4.
 */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
@TestPropertySource(properties = {
        "app.notification.action-item-assignment-enabled=true",
        "app.notification.action-item-assignment-delivery-enabled=false",
        "app.email.delivery.worker-enabled=false"
})
class ActionItemAssignmentNotificationIntegrationTests {
    @Autowired JdbcTemplate jdbc;
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired ActionItemProposalSink sink;
    @Autowired ActionItemService service;
    @Autowired PlatformTransactionManager txManager;
    @Autowired List<TransactionalEmailHandler> registeredHandlers;

    private UUID organizer;
    private UUID firstAssignee;
    private UUID secondAssignee;
    private UUID meeting;

    @BeforeEach
    void seed() {
        organizer = activeUser();
        firstAssignee = activeUser();
        secondAssignee = activeUser();
        meeting = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'AI08.3 canonical assignment',?,?)
            """, meeting, organizer, organizer);
    }

    @Test
    void manualCreateReplayAndAtoBtoAReassignEachHaveCanonicalEventAndIntent() throws Exception {
        assertThat(registeredHandlers.stream()
                .noneMatch(handler -> handler.notificationType().equals("ACTION_ITEM_ASSIGNED"))).isTrue();

        String idempotencyKey = "ai08-event-" + UUID.randomUUID();
        MvcResult created = createManual(firstAssignee, idempotencyKey, "Prepare project report");
        UUID item = itemId(created);
        assertThat(eventCount(item)).isEqualTo(1);
        assertThat(intentCount(item)).isEqualTo(1);
        UUID initial = eventId(item, 0L);
        assertEvent(item, initial, 0L, "ASSIGNED", firstAssignee, "ASSIGNEE", "PENDING");

        MvcResult replay = createManual(firstAssignee, idempotencyKey, "Prepare project report");
        assertThat(itemId(replay)).isEqualTo(item);
        assertThat(eventCount(item)).isEqualTo(1);
        assertThat(intentCount(item)).isEqualTo(1);

        MvcResult titleEdit = patchItem(item, created.getResponse().getHeader(HttpHeaders.ETAG),
                Map.of("title", "Prepare updated project report"));
        assertThat(eventCount(item)).isEqualTo(1);
        MvcResult noOp = patchItem(item, titleEdit.getResponse().getHeader(HttpHeaders.ETAG),
                Map.of("title", "Prepare updated project report"));
        assertThat(eventCount(item)).isEqualTo(1);
        assertThat(noOp.getResponse().getHeader(HttpHeaders.ETAG))
                .isEqualTo(titleEdit.getResponse().getHeader(HttpHeaders.ETAG));

        MvcResult assignedToB = patchItem(item, noOp.getResponse().getHeader(HttpHeaders.ETAG),
                Map.of("assigneeUserId", secondAssignee));
        assertThat(eventCount(item)).isEqualTo(2);
        UUID second = eventId(item, 2L);
        assertEvent(item, second, 2L, "REASSIGNED", secondAssignee, "ASSIGNEE", "PENDING");

        patchItem(item, assignedToB.getResponse().getHeader(HttpHeaders.ETAG),
                Map.of("assigneeUserId", firstAssignee));
        UUID third = eventId(item, 3L);
        assertThat(List.of(initial, second, third).stream().distinct().count()).isEqualTo(3);
        assertEvent(item, third, 3L, "REASSIGNED", firstAssignee, "ASSIGNEE", "PENDING");
        assertThat(eventCount(item)).isEqualTo(3);
        assertThat(intentCount(item)).isEqualTo(3);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM action_item_history
             WHERE action_item_id=? AND change_type='ASSIGNEE'
            """, Integer.class, item)).isEqualTo(3);
    }

    @Test
    void aiProposalNeverNotifiesUntilHumanConfirmationOfOfficialAssignment() throws Exception {
        UUID proposed = createRealAiProposal();
        assertThat(eventCount(proposed)).isZero();
        assertThat(intentCount(proposed)).isZero();

        MvcResult detail = mvc.perform(get("/api/v1/action-items/{id}", proposed)
                .principal(principal())).andExpect(status().isOk()).andReturn();
        MvcResult assigned = patchItem(proposed, detail.getResponse().getHeader(HttpHeaders.ETAG),
                Map.of("assigneeUserId", firstAssignee));
        assertThat(eventCount(proposed)).isZero();
        assertThat(intentCount(proposed)).isZero();

        MvcResult confirmed = mvc.perform(post("/api/v1/action-items/{id}/confirm", proposed)
                .principal(principal())
                .header(HttpHeaders.IF_MATCH, assigned.getResponse().getHeader(HttpHeaders.ETAG)))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(confirmed).path("data").path("status").asText()).isEqualTo("OPEN");
        assertThat(eventCount(proposed)).isEqualTo(1);
        assertThat(intentCount(proposed)).isEqualTo(1);
        UUID event = eventId(proposed, 2L);
        assertEvent(proposed, event, 2L, "ASSIGNED", firstAssignee, "STATUS", "PENDING");
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM action_item_history WHERE action_item_id=?
                AND change_type='ASSIGNEE' AND from_value IS NULL
            """, Integer.class, proposed)).isZero();
    }

    @Test
    void consentDisabledAtIntentCreationIsDurablySkipped() throws Exception {
        jdbc.update("""
            INSERT INTO user_preferences(user_id,action_item_email_enabled)
            VALUES (?,false)
            """, firstAssignee);
        UUID item = itemId(createManual(firstAssignee, null, "Disabled optional mail"));
        assertThat(eventCount(item)).isEqualTo(1);
        assertThat(intentCount(item)).isEqualTo(1);
        UUID event = eventId(item, 0);
        assertEvent(item, event, 0, "ASSIGNED", firstAssignee, "ASSIGNEE", "SKIPPED");
        assertThat(jdbc.queryForObject("""
            SELECT skip_reason FROM email_deliveries WHERE related_entity_id=?
            """, String.class, event)).isEqualTo("USER_PREFERENCE_DISABLED");
    }

    @Test
    void competingSameIdempotencyKeyPostsProduceOneCommittedEventAndIntent() throws Exception {
        String key = "ai08-concurrent-" + UUID.randomUUID();
        CountDownLatch ready = new CountDownLatch(2), go = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            Callable<MvcResult> send = () -> {
                ready.countDown();
                if (!go.await(15, TimeUnit.SECONDS)) throw new AssertionError("Start timeout");
                return createManual(firstAssignee, key, "Parallel create once");
            };
            var first = pool.submit(send);
            var second = pool.submit(send);
            assertThat(ready.await(15, TimeUnit.SECONDS)).isTrue();
            go.countDown();
            UUID one = itemId(first.get(50, TimeUnit.SECONDS));
            UUID two = itemId(second.get(50, TimeUnit.SECONDS));
            assertThat(two).isEqualTo(one);
            assertThat(eventCount(one)).isEqualTo(1);
            assertThat(intentCount(one)).isEqualTo(1);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM action_item_history WHERE action_item_id=?
            """, Integer.class, one)).isEqualTo(2);
        } finally {
            go.countDown();
        }
    }

    @Test
    void outerBusinessRollbackRemovesTaskHistoryEventAndIntent() {
        String title = "Rollback atomic action " + UUID.randomUUID();
        var tx = new TransactionTemplate(txManager);
        assertThatThrownBy(() -> tx.executeWithoutResult(status -> {
            service.createManual(organizer,
                    new CreateActionItemRequest(meeting, title, null, firstAssignee, null));
            throw new IllegalStateException("Deliberate business rollback");
        })).isInstanceOf(IllegalStateException.class)
          .hasMessageContaining("Deliberate business rollback");
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM action_items WHERE meeting_id=? AND title=?
            """, Integer.class, meeting, title)).isZero();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM action_item_assignment_events event
             JOIN action_items item ON item.id=event.action_item_id WHERE item.meeting_id=?
            """, Integer.class, meeting)).isZero();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries
             WHERE notification_type='ACTION_ITEM_ASSIGNED'
               AND recipient_user_id=?
            """, Integer.class, firstAssignee)).isZero();
    }

    @Test
    void forgedOrMutatedDirectSqlAssignmentEventsFailDatabaseGuards() throws Exception {
        UUID item = itemId(createManual(firstAssignee, null, "Protected source event"));
        UUID valid = eventId(item, 0);
        UUID historyId = jdbc.queryForObject("""
            SELECT history_id FROM action_item_assignment_events WHERE id=?
            """, UUID.class, valid);

        assertThatThrownBy(() -> jdbc.update("""
            INSERT INTO action_item_assignment_events
              (id,action_item_id,action_item_version,history_id,assignee_user_id,event_type)
            VALUES (?,?,?,?,?,'REASSIGNED')
            """, UUID.randomUUID(), item, 111L, historyId, firstAssignee))
            .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update("""
            UPDATE action_item_assignment_events SET event_type='REASSIGNED' WHERE id=?
            """, valid)).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update("""
            DELETE FROM action_item_assignment_events WHERE id=?
            """, valid)).isInstanceOf(DataIntegrityViolationException.class);
        assertThat(eventCount(item)).isEqualTo(1);
    }

    private UUID activeUser() {
        UUID id = UUID.randomUUID();
        String email = "ai08-assignee-" + id + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'AI08 assignment actor','test-only','EMPLOYEE','ACTIVE')
            """, id, email, email);
        return id;
    }

    private Principal principal() {
        return () -> organizer.toString();
    }

    private MvcResult createManual(UUID assignee, String key, String title) throws Exception {
        var builder = post("/api/v1/action-items")
                .principal(principal()).contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of(
                    "meetingId", meeting, "title", title, "assigneeUserId", assignee)));
        if (key != null) builder.header("Idempotency-Key", key);
        return mvc.perform(builder).andExpect(status().isCreated()).andReturn();
    }

    private MvcResult patchItem(UUID item, String etag, Map<String, ?> patchData) throws Exception {
        return mvc.perform(patch("/api/v1/action-items/{id}", item)
                .principal(principal()).header(HttpHeaders.IF_MATCH, etag)
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(patchData)))
            .andExpect(status().isOk()).andReturn();
    }

    private UUID itemId(MvcResult response) throws Exception {
        return UUID.fromString(body(response).path("data").path("id").asText());
    }

    private JsonNode body(MvcResult response) throws Exception {
        return json.readTree(response.getResponse().getContentAsString());
    }

    private int eventCount(UUID item) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM action_item_assignment_events WHERE action_item_id=?
            """, Integer.class, item);
    }

    private int intentCount(UUID item) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries WHERE notification_type='ACTION_ITEM_ASSIGNED'
              AND related_entity_type='ACTION_ITEM_ASSIGNMENT'
              AND related_entity_id IN (
                  SELECT id FROM action_item_assignment_events WHERE action_item_id=?)
            """, Integer.class, item);
    }

    private UUID eventId(UUID item, long version) {
        return jdbc.queryForObject("""
            SELECT id FROM action_item_assignment_events
             WHERE action_item_id=? AND action_item_version=?
            """, UUID.class, item, version);
    }

    private void assertEvent(UUID item, UUID eventId, long version, String type, UUID assignee,
            String historyType, String deliveryStatus) {
        assertThat(jdbc.queryForObject("""
            SELECT event_type FROM action_item_assignment_events WHERE id=?
            """, String.class, eventId)).isEqualTo(type);
        assertThat(jdbc.queryForObject("""
            SELECT action_item_version FROM action_item_assignment_events WHERE id=?
            """, Long.class, eventId)).isEqualTo(version);
        assertThat(jdbc.queryForObject("""
            SELECT h.change_type FROM action_item_assignment_events e
            JOIN action_item_history h ON h.id=e.history_id AND h.action_item_id=e.action_item_id
            WHERE e.id=?
            """, String.class, eventId)).isEqualTo(historyType);
        assertThat(jdbc.queryForObject("""
            SELECT recipient_user_id FROM email_deliveries WHERE related_entity_id=?
            """, UUID.class, eventId)).isEqualTo(assignee);
        assertThat(jdbc.queryForObject("""
            SELECT status FROM email_deliveries WHERE related_entity_id=?
            """, String.class, eventId)).isEqualTo(deliveryStatus);
        assertThat(jdbc.queryForObject("""
            SELECT dedupe_key FROM email_deliveries WHERE related_entity_id=?
            """, String.class, eventId)).isEqualTo("action-item-assignment:" + eventId);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM action_item_assignment_events WHERE id=? AND action_item_id=?
            """, Integer.class, eventId, item)).isEqualTo(1);
    }

    /** Real MI-10 acceptance of one candidate with source evidence, not a fake PROPOSED row. */
    private UUID createRealAiProposal() {
        UUID media = UUID.randomUUID(), job = UUID.randomUUID(), transcript = UUID.randomUUID();
        UUID segment = UUID.randomUUID(), snapshot = UUID.randomUUID(), stage = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,10000,?,CURRENT_TIMESTAMP)
            """, media, meeting, "meetings/" + meeting + "/sources/" + media,
                "meetings/" + meeting + "/pending/" + media, organizer);
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status)
            VALUES (?,?,?,?,'RUNNING')
            """, job, meeting, media, organizer);
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,version_number,
                language_code,status,is_current,content_revision)
            VALUES (?,?,?,?,1,'vi','READY',TRUE,3)
            """, transcript, meeting, media, job);
        jdbc.update("""
            INSERT INTO transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,current_text,quality_status)
            VALUES (?,?,0,0,1000,'AI08.3 candidate evidence','ACCEPTED')
            """, segment, transcript);
        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(
                id,meeting_id,source_media_id,processing_job_id,transcript_id,
                content_revision,sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,3,?,?,100)
            """, snapshot, meeting, media, job, transcript, "a".repeat(64),
                "processing/" + job + "/intelligence/source/" + snapshot + ".json");
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,
                attempt_number,status,claim_token,lease_expires_at)
            VALUES (?,?,'EXTRACTING_ACTION_ITEMS',1,'RUNNING',?,CURRENT_TIMESTAMP+INTERVAL '1 hour')
            """, stage, job, UUID.randomUUID());
        List<Candidate> candidates = List.of(new Candidate("ai08-task-1",
            "Prepare action item handoff", null, LocalDate.parse("2027-01-09"), List.of(segment)));
        Batch batch = new Batch(meeting, job, stage, snapshot, transcript, 3, false,
            ActionItemBatchFingerprint.sha256(json, candidates), candidates);
        var receipt = new TransactionTemplate(txManager).execute(tx -> sink.acceptProposed(batch));
        assertThat(receipt).isNotNull();
        assertThat(receipt.newProposals()).isEqualTo(1);
        return jdbc.queryForObject("""
            SELECT id FROM action_items WHERE proposal_batch_id=(
                SELECT id FROM action_item_batch_receipts WHERE stage_run_id=?)
            """, UUID.class, stage);
    }
}
