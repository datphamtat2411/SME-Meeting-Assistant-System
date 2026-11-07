package com.sme.meetingassistant.api.notification;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.actionitem.service.ActionItemBatchFingerprint;
import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink;
import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink.Batch;
import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink.Candidate;
import com.sme.meetingassistant.api.notification.email.TransactionalEmailDeliveryWorker;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mail.MailSendException;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;

/**
 * AI-08.6 cross-module acceptance: real HTTP business operations, independent
 * PostgreSQL commits, a single delivery worker, and mocked SMTP handoffs.
 * The two assignment gates are explicitly enabled only for this test context.
 */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
@TestPropertySource(properties = {
    "app.notification.action-item-assignment-enabled=true",
    "app.notification.action-item-assignment-delivery-enabled=true",
    "app.email.delivery.worker-enabled=false",
    "app.email.delivery.sender=acceptance@example.com"
})
class ActionItemsNotificationsCrossModuleAcceptanceIntegrationTests {
    private static final String START = "2031-01-15T09:00:00Z";
    private static final String END = "2031-01-15T10:00:00Z";
    private static final String LATER = "2031-01-15T11:00:00Z";

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired TransactionalEmailDeliveryWorker worker;
    @Autowired ActionItemProposalSink aiSink;
    @Autowired PlatformTransactionManager txManager;
    @MockitoBean JavaMailSender smtp;

    private UUID organizer;

    @BeforeEach
    void isolateQueuedTestFixtures() {
        // The integration database is reused across test contexts. Discard only
        // unclaimed fixture mail so this test proves its own bounded handoffs;
        // never modify SENT historical rows or production configuration.
        jdbc.update("""
            UPDATE email_deliveries SET status='SKIPPED',
                skip_reason='TEST_FIXTURE_ISOLATION',next_attempt_at=NULL,
                last_error_code=NULL,last_error_summary=NULL,
                updated_at=clock_timestamp()
            WHERE status IN ('PENDING','FAILED','SENDING')
            """);
        organizer = user();
    }

    @Test
    void scheduledMeetingAndOfficialAssignmentShareOneWorkerWithoutLeakingMeetingContent()
            throws Exception {
        UUID employee = user();
        MvcResult draft = draft(employee);
        UUID meeting = id(draft);
        commandMeeting(meeting, "schedule", tag(draft));
        MvcResult action = createAction(meeting, employee);
        UUID item = id(action);
        UUID event = lastEvent(item);

        assertThat(itemStatus(item)).isEqualTo("OPEN");
        assertThat(meetingStatus(meeting)).isEqualTo("SCHEDULED");
        assertThat(eventCount(item)).isEqualTo(1);
        assertThat(deliveryStatus(meetingDelivery(meeting,"MEETING_SCHEDULED",organizer)))
            .isEqualTo("PENDING");
        assertThat(deliveryStatus(meetingDelivery(meeting,"MEETING_SCHEDULED",employee)))
            .isEqualTo("PENDING");
        assertThat(deliveryStatus(assignmentDelivery(event))).isEqualTo("PENDING");

        assertThat(worker.deliverOne()).isTrue();
        assertThat(worker.deliverOne()).isTrue();
        assertThat(worker.deliverOne()).isTrue();
        assertThat(worker.deliverOne()).isFalse();

        assertThat(deliveryStatus(meetingDelivery(meeting,"MEETING_SCHEDULED",organizer)))
            .isEqualTo("SENT");
        assertThat(deliveryStatus(meetingDelivery(meeting,"MEETING_SCHEDULED",employee)))
            .isEqualTo("SENT");
        assertThat(deliveryStatus(assignmentDelivery(event))).isEqualTo("SENT");

        var sent = captureMails(3);
        assertThat(sent.stream().filter(x -> "Meeting scheduled".equals(x.getSubject())).count())
            .isEqualTo(2);
        assertThat(sent.stream().filter(x -> "Action item assigned".equals(x.getSubject())).count())
            .isEqualTo(1);
        assertThat(sent.stream().filter(x -> "Action item assigned".equals(x.getSubject()))
            .findFirst().orElseThrow().getTo()).containsExactly(email(employee));
        for (var mail : sent) {
            assertThat(mail.getText()).doesNotContain(
                "Private financial acquisition agenda", "Classified customer deliverables",
                meeting.toString(), item.toString(), event.toString());
            assertThat(mail.getFrom()).isEqualTo("acceptance@example.com");
        }
    }

    @Test
    void meetingAndActionItemPreferencesAreIndependentForTheSameUsers() throws Exception {
        UUID actionOnly = user(), meetingOnly = user();
        preferences(actionOnly, false, true);
        preferences(meetingOnly, true, false);
        MvcResult draft = draft(actionOnly, meetingOnly);
        UUID meeting = id(draft);
        commandMeeting(meeting, "schedule", tag(draft));
        UUID firstEvent = lastEvent(id(createAction(meeting, actionOnly)));
        UUID secondEvent = lastEvent(id(createAction(meeting, meetingOnly)));

        assertThat(deliveryStatus(meetingDelivery(meeting,"MEETING_SCHEDULED",actionOnly)))
            .isEqualTo("SKIPPED");
        assertThat(deliveryStatus(meetingDelivery(meeting,"MEETING_SCHEDULED",meetingOnly)))
            .isEqualTo("PENDING");
        assertThat(deliveryStatus(assignmentDelivery(firstEvent))).isEqualTo("PENDING");
        assertThat(deliveryStatus(assignmentDelivery(secondEvent))).isEqualTo("SKIPPED");

        assertThat(worker.deliverOne()).isTrue();
        assertThat(worker.deliverOne()).isTrue();
        assertThat(worker.deliverOne()).isTrue();
        assertThat(worker.deliverOne()).isFalse();

        var sent = captureMails(3);
        assertThat(sent.stream().filter(x -> List.of(x.getTo()).contains(email(actionOnly))).count())
            .isEqualTo(1);
        assertThat(sent.stream().filter(x -> List.of(x.getTo()).contains(email(meetingOnly))).count())
            .isEqualTo(1);
        assertThat(sent.stream().filter(x -> List.of(x.getTo()).contains(email(actionOnly)))
            .findFirst().orElseThrow().getSubject()).isEqualTo("Action item assigned");
        assertThat(sent.stream().filter(x -> List.of(x.getTo()).contains(email(meetingOnly)))
            .findFirst().orElseThrow().getSubject()).isEqualTo("Meeting scheduled");
        assertThat(deliveryStatus(assignmentDelivery(secondEvent))).isEqualTo("SKIPPED");
        assertThat(deliveryStatus(meetingDelivery(meeting,"MEETING_SCHEDULED",actionOnly)))
            .isEqualTo("SKIPPED");
    }

    @Test
    void cancellationAndTaskCompletionSupersedeTheirOwnQueuedIntentsIndependently()
            throws Exception {
        UUID employee = user();
        MvcResult draft = draft(employee);
        UUID meeting = id(draft);
        MvcResult scheduled = commandMeeting(meeting, "schedule", tag(draft));
        MvcResult created = createAction(meeting, employee);
        UUID item = id(created), event = lastEvent(item);
        MvcResult rescheduled = editMeeting(meeting, tag(scheduled),
            Map.of("scheduledEndAt", LATER));
        commandMeeting(meeting, "cancel", tag(rescheduled));
        commandAction(item, "complete", tag(created));

        assertThat(meetingStatus(meeting)).isEqualTo("CANCELLED");
        assertThat(itemStatus(item)).isEqualTo("DONE");
        assertThat(eventCount(item)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM action_item_assignment_revocations WHERE event_id=?
            """, Integer.class, event)).isEqualTo(1);
        assertThat(deliveryStatus(assignmentDelivery(event))).isEqualTo("SKIPPED");
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries
             WHERE related_entity_type='MEETING' AND related_entity_id=?
               AND notification_type IN ('MEETING_SCHEDULED','MEETING_RESCHEDULED')
               AND status='PENDING'
            """,Integer.class,meeting)).isZero();
        assertThat(deliveryStatus(meetingDelivery(meeting,"MEETING_CANCELLED",employee)))
            .isEqualTo("PENDING");

        assertThat(worker.deliverOne()).isTrue();
        assertThat(worker.deliverOne()).isTrue();
        assertThat(worker.deliverOne()).isFalse();
        assertThat(captureMails(2)).allSatisfy(message ->
            assertThat(message.getSubject()).isEqualTo("Meeting cancelled"));
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries
             WHERE related_entity_type='ACTION_ITEM_ASSIGNMENT'
               AND related_entity_id=? AND status='SENT'
            """,Integer.class,event)).isZero();
    }

    @Test
    void smtpOutageDoesNotUndoMeetingOrActionAndRetryUsesSameDeliveryIdentity()
            throws Exception {
        MvcResult draft = draft();
        UUID meeting = id(draft);
        commandMeeting(meeting, "schedule", tag(draft));
        UUID queued = meetingDelivery(meeting,"MEETING_SCHEDULED",organizer);
        UUID item = id(createAction(meeting,user()));
        UUID event = lastEvent(item);

        doThrow(new MailSendException("private SMTP provider credentials must not persist"))
            .doNothing().doNothing().when(smtp).send(any(SimpleMailMessage.class));

        assertThat(worker.deliverOne()).isTrue();
        assertThat(deliveryStatus(queued)).isEqualTo("FAILED");
        assertThat(meetingStatus(meeting)).isEqualTo("SCHEDULED");
        assertThat(itemStatus(item)).isEqualTo("OPEN");

        assertThat(worker.deliverOne()).isTrue();
        assertThat(deliveryStatus(assignmentDelivery(event))).isEqualTo("SENT");
        assertThat(worker.deliverOne()).isFalse();
        jdbc.update("""
            UPDATE email_deliveries
               SET next_attempt_at=clock_timestamp()-INTERVAL '1 minute'
             WHERE id=?
            """,queued);
        assertThat(worker.deliverOne()).isTrue();
        assertThat(deliveryStatus(queued)).isEqualTo("SENT");
        assertThat(jdbc.queryForObject("""
            SELECT attempt_count FROM email_deliveries WHERE id=?
            """,Integer.class,queued)).isEqualTo(2);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries
             WHERE related_entity_id=? AND notification_type='MEETING_SCHEDULED'
            """,Integer.class,meeting)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT last_error_summary FROM email_deliveries WHERE id=?
            """,String.class,queued)).isNull();
        assertThat(meetingStatus(meeting)).isEqualTo("SCHEDULED");
        assertThat(itemStatus(item)).isEqualTo("OPEN");
        verify(smtp,times(3)).send(any(SimpleMailMessage.class));
    }

    @Test
    void aiHandoffIsOnlyProposalUntilHumanConfirmationThenOneOfficialEmail()
            throws Exception {
        UUID employee=user();
        MvcResult draft=draft();
        UUID meeting=id(draft);
        var proposal=createRealAiProposal(meeting);
        UUID item=proposal.itemId();

        assertThat(itemStatus(item)).isEqualTo("PROPOSED");
        assertThat(eventCount(item)).isZero();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries
             WHERE notification_type='ACTION_ITEM_ASSIGNED'
               AND related_entity_id IN (
                   SELECT id FROM action_item_assignment_events WHERE action_item_id=?)
            """,Integer.class,item)).isZero();
        MvcResult detail=mvc.perform(get("/api/v1/action-items/{id}",item)
            .principal(actor())).andExpect(status().isOk()).andReturn();
        MvcResult corrected=mvc.perform(patch("/api/v1/action-items/{id}",item)
            .principal(actor()).header(HttpHeaders.IF_MATCH,tag(detail))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("assigneeUserId",employee))))
            .andExpect(status().isOk()).andReturn();
        assertThat(eventCount(item)).isZero();

        mvc.perform(post("/api/v1/action-items/{id}/confirm",item)
            .principal(actor()).header(HttpHeaders.IF_MATCH,tag(corrected)))
            .andExpect(status().isOk());
        assertThat(itemStatus(item)).isEqualTo("OPEN");
        assertThat(eventCount(item)).isEqualTo(1);
        UUID event=lastEvent(item);
        assertThat(deliveryStatus(assignmentDelivery(event))).isEqualTo("PENDING");

        var receipt=new TransactionTemplate(txManager).execute(tx ->
            aiSink.acceptProposed(proposal.batch()));
        assertThat(receipt).isNotNull();
        assertThat(receipt.replay()).isTrue();
        assertThat(receipt.newProposals()).isZero();
        assertThat(eventCount(item)).isEqualTo(1);

        assertThat(worker.deliverOne()).isTrue();
        assertThat(worker.deliverOne()).isFalse();
        assertThat(deliveryStatus(assignmentDelivery(event))).isEqualTo("SENT");
        var sent=captureMails(1);
        assertThat(sent.getFirst().getTo()).containsExactly(email(employee));
        assertThat(sent.getFirst().getSubject()).isEqualTo("Action item assigned");
        assertThat(sent.getFirst().getText()).doesNotContain(
            "AI08.6 private transcript evidence",item.toString(),meeting.toString());
    }

    @Test
    void independentWorkersCannotDoubleClaimSameBusinessEvent() throws Exception {
        MvcResult draft = draft();
        UUID meeting = id(draft);
        commandMeeting(meeting, "schedule", tag(draft));
        UUID meetingMail = meetingDelivery(meeting,"MEETING_SCHEDULED",organizer);
        UUID event = lastEvent(id(createAction(meeting,user())));
        UUID actionMail = assignmentDelivery(event);

        var ready = new CountDownLatch(2);
        var start = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            Callable<Boolean> send = () -> {
                ready.countDown();
                if (!start.await(15,TimeUnit.SECONDS)) throw new IllegalStateException("Start timeout");
                return worker.deliverOne();
            };
            var a = pool.submit(send);
            var b = pool.submit(send);
            assertThat(ready.await(15,TimeUnit.SECONDS)).isTrue();
            start.countDown();
            assertThat(a.get(40,TimeUnit.SECONDS)).isTrue();
            assertThat(b.get(40,TimeUnit.SECONDS)).isTrue();
        } finally {
            start.countDown();
        }

        assertThat(deliveryStatus(meetingMail)).isEqualTo("SENT");
        assertThat(deliveryStatus(actionMail)).isEqualTo("SENT");
        assertThat(jdbc.queryForObject("""
            SELECT attempt_count FROM email_deliveries WHERE id=?
            """,Integer.class,meetingMail)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT attempt_count FROM email_deliveries WHERE id=?
            """,Integer.class,actionMail)).isEqualTo(1);
        verify(smtp,times(2)).send(any(SimpleMailMessage.class));
        assertThat(worker.deliverOne()).isFalse();
    }

    @Test
    void unauthorizedAndStaleHttpRequestsNeverManufactureExtraAssignmentOrMeetingMail()
            throws Exception {
        UUID employee=user(), outsider=user();
        MvcResult draft=draft(employee);
        UUID meeting=id(draft);
        MvcResult scheduled=commandMeeting(meeting,"schedule",tag(draft));
        MvcResult created=createAction(meeting,employee);
        UUID item=id(created);
        int queuedBefore=deliveryCount(meeting);
        assertThat(queuedBefore).isEqualTo(2);
        assertThat(eventCount(item)).isEqualTo(1);

        mvc.perform(patch("/api/v1/action-items/{id}",item)
            .principal(() -> outsider.toString())
            .header(HttpHeaders.IF_MATCH,tag(created))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("assigneeUserId",outsider))))
            .andExpect(status().is4xxClientError());
        mvc.perform(patch("/api/v1/meetings/{id}",meeting)
            .principal(() -> outsider.toString())
            .header(HttpHeaders.IF_MATCH,tag(scheduled))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("scheduledEndAt",LATER))))
            .andExpect(status().is4xxClientError());

        MvcResult changed=mvc.perform(patch("/api/v1/action-items/{id}",item)
            .principal(actor()).header(HttpHeaders.IF_MATCH,tag(created))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("title","Edited without assigning"))))
            .andExpect(status().isOk()).andReturn();
        mvc.perform(patch("/api/v1/action-items/{id}",item)
            .principal(actor()).header(HttpHeaders.IF_MATCH,tag(created))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("assigneeUserId",outsider))))
            .andExpect(status().isPreconditionFailed());

        assertThat(tag(changed)).isNotEqualTo(tag(created));
        assertThat(eventCount(item)).isEqualTo(1);
        assertThat(deliveryCount(meeting)).isEqualTo(queuedBefore);
        assertThat(deliveryStatus(assignmentDelivery(lastEvent(item)))).isEqualTo("PENDING");
        assertThat(meetingStatus(meeting)).isEqualTo("SCHEDULED");
        verifyNoInteractions(smtp);
    }

    /** Real MI-G7 source acceptance, not fabricated PROPOSED SQL. */
    private record AcceptedProposal(UUID itemId, Batch batch) {}

    private AcceptedProposal createRealAiProposal(UUID meeting) {
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
            VALUES (?,?,0,0,1000,'AI08.6 private transcript evidence','ACCEPTED')
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
        List<Candidate> candidates=List.of(new Candidate("ai086-proposal-1",
            "Source-backed proposed action",null,LocalDate.parse("2031-01-18"),
            List.of(segment)));
        Batch batch=new Batch(meeting,job,stage,snapshot,transcript,3,false,
            ActionItemBatchFingerprint.sha256(json,candidates),candidates);
        var receipt=new TransactionTemplate(txManager).execute(tx ->
            aiSink.acceptProposed(batch));
        assertThat(receipt).isNotNull();
        assertThat(receipt.newProposals()).isEqualTo(1);
        UUID item=jdbc.queryForObject("""
            SELECT id FROM action_items WHERE proposal_batch_id=(
                SELECT id FROM action_item_batch_receipts WHERE stage_run_id=?)
            """,UUID.class,stage);
        return new AcceptedProposal(item,batch);
    }

    private UUID user() {
        UUID id=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,
                global_role,account_status)
            VALUES (?,?,?,'AI08.6 org account','test-only','EMPLOYEE','ACTIVE')
            """,id,email(id),email(id));
        return id;
    }
    private static String email(UUID id) { return "ai086-"+id+"@example.invalid"; }
    private Principal actor() { return () -> organizer.toString(); }
    private String tag(MvcResult r) { return r.getResponse().getHeader(HttpHeaders.ETAG); }
    private UUID id(MvcResult r) throws Exception {
        return UUID.fromString(json.readTree(r.getResponse().getContentAsString())
            .path("data").path("id").asText());
    }
    private MvcResult draft(UUID... invitees) throws Exception {
        Map<String,Object> body=new LinkedHashMap<>();
        body.put("title","Private financial acquisition agenda");
        body.put("scheduledStartAt",START);
        body.put("scheduledEndAt",END);
        body.put("participantUserIds",List.of(invitees));
        return mvc.perform(post("/api/v1/meetings")
            .principal(actor()).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(body)))
            .andExpect(status().isCreated()).andReturn();
    }
    private MvcResult commandMeeting(UUID meeting,String action,String etag) throws Exception {
        return mvc.perform(post("/api/v1/meetings/{id}/{cmd}",meeting,action)
            .principal(actor()).header(HttpHeaders.IF_MATCH,etag))
            .andExpect(status().isOk()).andReturn();
    }
    private MvcResult editMeeting(UUID meeting,String etag,Map<String,?> data) throws Exception {
        return mvc.perform(patch("/api/v1/meetings/{id}",meeting)
            .principal(actor()).header(HttpHeaders.IF_MATCH,etag)
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(data)))
            .andExpect(status().isOk()).andReturn();
    }
    private MvcResult createAction(UUID meeting,UUID assignee) throws Exception {
        return mvc.perform(post("/api/v1/action-items")
            .principal(actor()).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of(
                "meetingId",meeting,"title","Classified customer deliverables",
                "assigneeUserId",assignee))))
            .andExpect(status().isCreated()).andReturn();
    }
    private MvcResult commandAction(UUID item,String cmd,String etag) throws Exception {
        return mvc.perform(post("/api/v1/action-items/{id}/{cmd}",item,cmd)
            .principal(actor()).header(HttpHeaders.IF_MATCH,etag))
            .andExpect(status().isOk()).andReturn();
    }
    private UUID lastEvent(UUID item) {
        return jdbc.queryForObject("""
            SELECT id FROM action_item_assignment_events WHERE action_item_id=?
            ORDER BY action_item_version DESC LIMIT 1
            """,UUID.class,item);
    }
    private int eventCount(UUID item) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM action_item_assignment_events WHERE action_item_id=?
            """,Integer.class,item);
    }
    private UUID assignmentDelivery(UUID event) {
        return jdbc.queryForObject("""
            SELECT id FROM email_deliveries
            WHERE notification_type='ACTION_ITEM_ASSIGNED'
              AND related_entity_type='ACTION_ITEM_ASSIGNMENT'
              AND related_entity_id=?
            """,UUID.class,event);
    }
    private UUID meetingDelivery(UUID meeting,String type,UUID recipient) {
        return jdbc.queryForObject("""
            SELECT id FROM email_deliveries WHERE related_entity_type='MEETING'
              AND related_entity_id=? AND notification_type=? AND recipient_user_id=?
            ORDER BY created_at DESC LIMIT 1
            """,UUID.class,meeting,type,recipient);
    }
    private int deliveryCount(UUID meeting) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries
             WHERE related_entity_type='MEETING' AND related_entity_id=?
            """,Integer.class,meeting);
    }
    private String deliveryStatus(UUID delivery) {
        return jdbc.queryForObject("SELECT status FROM email_deliveries WHERE id=?",
            String.class,delivery);
    }
    private String itemStatus(UUID item) {
        return jdbc.queryForObject("SELECT status FROM action_items WHERE id=?",
            String.class,item);
    }
    private String meetingStatus(UUID meeting) {
        return jdbc.queryForObject("SELECT status FROM meetings WHERE id=?",
            String.class,meeting);
    }
    private void preferences(UUID user,boolean meetingEmail,boolean assignmentEmail) {
        jdbc.update("""
            INSERT INTO user_preferences(user_id,meeting_email_enabled,action_item_email_enabled)
            VALUES (?,?,?)
            ON CONFLICT (user_id) DO UPDATE
               SET meeting_email_enabled=EXCLUDED.meeting_email_enabled,
                   action_item_email_enabled=EXCLUDED.action_item_email_enabled
            """,user,meetingEmail,assignmentEmail);
    }
    private List<SimpleMailMessage> captureMails(int count) {
        var captor=ArgumentCaptor.forClass(SimpleMailMessage.class);
        verify(smtp,times(count)).send(captor.capture());
        return captor.getAllValues();
    }
}
