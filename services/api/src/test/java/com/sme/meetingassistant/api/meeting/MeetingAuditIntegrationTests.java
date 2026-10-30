package com.sme.meetingassistant.api.meeting;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.audit.TransactionalAuditWriter;
import com.sme.meetingassistant.api.observability.RequestIdContext;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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
import org.springframework.transaction.IllegalTransactionStateException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * T01: Each HTTP command uses its own real PostgreSQL transaction, not a
 * surrounding test transaction. Failed commands must leave no success audit.
 */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class MeetingAuditIntegrationTests {
    private static final String NINE = "2030-11-03T09:00:00Z";
    private static final String TEN = "2030-11-03T10:00:00Z";
    private static final String ELEVEN = "2030-11-03T11:00:00Z";

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired TransactionalAuditWriter writer;

    private UUID owner, member, outsider, admin;

    @BeforeEach void setUp() {
        owner = user("EMPLOYEE");
        member = user("EMPLOYEE");
        outsider = user("EMPLOYEE");
        admin = user("ADMINISTRATOR");
    }

    private UUID user(String role) {
        UUID id = UUID.randomUUID();
        String email = "audit-" + id + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Audit fixture','test-only',?,'ACTIVE')
            """, id, email, email, role);
        return id;
    }

    private UUID room() {
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO rooms(id,code,name) VALUES (?,?,?)",
            id, "AUDIT-" + id, "Audit room");
        return id;
    }

    private static Principal principal(UUID userId) {
        return () -> userId.toString();
    }

    private JsonNode data(MvcResult result) {
        return json.readTree(result.getResponse().getContentAsString()).path("data");
    }

    private UUID id(MvcResult result) {
        return UUID.fromString(data(result).path("id").asText());
    }

    private static String tag(MvcResult result) {
        return result.getResponse().getHeader(HttpHeaders.ETAG);
    }

    private MvcResult create(UUID actor, Map<String, Object> payload) throws Exception {
        return mvc.perform(post("/api/v1/meetings").principal(principal(actor))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(payload)))
            .andExpect(status().isCreated()).andReturn();
    }

    private MvcResult schedule(UUID meeting, UUID actor, String ifMatch) throws Exception {
        return mvc.perform(post("/api/v1/meetings/" + meeting + "/schedule")
            .principal(principal(actor)).header(HttpHeaders.IF_MATCH, ifMatch))
            .andExpect(status().isOk()).andReturn();
    }

    private int count(UUID meeting, String action) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM audit_events WHERE meeting_id=? AND action_code=?
            """, Integer.class, meeting, action);
    }

    private int total(UUID meeting) {
        return jdbc.queryForObject("SELECT count(*) FROM audit_events WHERE meeting_id=?",
            Integer.class, meeting);
    }

    private JsonNode event(UUID meeting, String action) {
        String metadata = jdbc.queryForObject("""
            SELECT metadata::text FROM audit_events
            WHERE meeting_id=? AND action_code=? ORDER BY occurred_at DESC,id DESC LIMIT 1
            """, String.class, meeting, action);
        return json.readTree(metadata);
    }

    @Test void creationWritesDurableAttributedEventsIncludingInitialMembershipGrants() throws Exception {
        MvcResult created = create(owner, Map.of("title","PRIVATE MEETING NAME",
            "participantUserIds",List.of(member)));
        UUID meeting = id(created);
        assertThat(count(meeting,"MEETING_CREATED")).isEqualTo(1);
        assertThat(count(meeting,"MEETING_PARTICIPANT_ADDED")).isEqualTo(2);
        assertThat(total(meeting)).isEqualTo(3);
        assertThat(event(meeting,"MEETING_CREATED").path("initialParticipantCount").asInt())
            .isEqualTo(2);
        String requestId = created.getResponse().getHeader(RequestIdContext.HEADER_NAME);
        assertThat(requestId).isNotBlank();
        List<Map<String,Object>> rows = jdbc.queryForList("""
            SELECT actor_user_id,actor_type,entity_type,entity_id,
                   correlation_id,metadata::text AS metadata
              FROM audit_events WHERE meeting_id=? ORDER BY occurred_at,id
            """, meeting);
        assertThat(rows).allSatisfy(row -> {
            assertThat(row.get("actor_user_id")).isEqualTo(owner);
            assertThat(row.get("actor_type")).isEqualTo("USER");
            assertThat(row.get("correlation_id")).isEqualTo(requestId);
            assertThat(json.readTree((String)row.get("metadata"))
                .path("outcome").asText()).isEqualTo("SUCCESS");
            assertThat((String)row.get("metadata")).doesNotContain("PRIVATE MEETING NAME");
        });
        UUID membership = jdbc.queryForObject("""
            SELECT id FROM meeting_participants WHERE meeting_id=? AND user_id=?
            """, UUID.class, meeting, member);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM audit_events WHERE meeting_id=?
              AND entity_type='MEETING_PARTICIPANT' AND entity_id=?
            """, Integer.class, meeting, membership)).isEqualTo(1);
    }

    @Test void scheduledAndRoomlessRescheduledChangesRetainBeforeAfterWithoutPrivateContent()
            throws Exception {
        MvcResult draft = create(owner, Map.of("title","Secret strategy",
            "scheduledStartAt",NINE,"scheduledEndAt",TEN));
        UUID meeting = id(draft);
        MvcResult scheduled = schedule(meeting,owner,tag(draft));
        assertThat(count(meeting,"MEETING_SCHEDULED")).isEqualTo(1);
        MvcResult changed = mvc.perform(patch("/api/v1/meetings/" + meeting)
            .principal(principal(owner)).header(HttpHeaders.IF_MATCH,tag(scheduled))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("scheduledStartAt",TEN,
                "scheduledEndAt",ELEVEN,"description","CONFIDENTIAL NOTES"))))
            .andExpect(status().isOk()).andReturn();
        assertThat(data(changed).path("status").asText()).isEqualTo("SCHEDULED");
        assertThat(count(meeting,"MEETING_RESCHEDULED")).isEqualTo(1);
        JsonNode audit = event(meeting,"MEETING_RESCHEDULED");
        assertThat(audit.path("before").path("scheduledStartAt").asText()).isEqualTo(NINE);
        assertThat(audit.path("after").path("scheduledStartAt").asText()).isEqualTo(TEN);
        assertThat(audit.path("changedFields").toString()).contains("description");
        assertThat(audit.toString()).doesNotContain("Secret strategy","CONFIDENTIAL NOTES");
        // No booking was involved: audit cannot depend on reservation history.
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM room_reservations WHERE meeting_id=?
            """,Integer.class,meeting)).isZero();
        // Semantically identical offset is not a reschedule.
        mvc.perform(patch("/api/v1/meetings/" + meeting)
            .principal(principal(owner)).header(HttpHeaders.IF_MATCH,tag(changed))
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"scheduledStartAt\":\"2030-11-03T17:00:00+07:00\"}"))
            .andExpect(status().isOk());
        assertThat(count(meeting,"MEETING_RESCHEDULED")).isEqualTo(1);
    }

    @Test void participantRemovalReadditionPreservesDistinctMembershipIdentityAndAudits()
            throws Exception {
        MvcResult draft = create(owner, Map.of("title","Access change",
            "participantUserIds",List.of(member)));
        UUID meeting = id(draft);
        UUID oldMembership = jdbc.queryForObject("""
            SELECT id FROM meeting_participants WHERE meeting_id=? AND user_id=?
                AND removed_at IS NULL
            """, UUID.class, meeting, member);
        MvcResult removed = mvc.perform(delete(
            "/api/v1/meetings/" + meeting + "/participants/" + member)
            .principal(principal(owner)).header(HttpHeaders.IF_MATCH,tag(draft)))
            .andExpect(status().isOk()).andReturn();
        assertThat(count(meeting,"MEETING_PARTICIPANT_REMOVED")).isEqualTo(1);
        assertThat(event(meeting,"MEETING_PARTICIPANT_REMOVED")
            .path("affectedUserId").asText()).isEqualTo(member.toString());
        assertThat(jdbc.queryForObject("""
            SELECT entity_id FROM audit_events
              WHERE meeting_id=? AND action_code='MEETING_PARTICIPANT_REMOVED'
            """, UUID.class, meeting)).isEqualTo(oldMembership);
        mvc.perform(get("/api/v1/meetings/" + meeting).principal(principal(member)))
            .andExpect(status().isNotFound());
        mvc.perform(post("/api/v1/meetings/" + meeting + "/participants")
            .principal(principal(owner)).header(HttpHeaders.IF_MATCH,tag(removed))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("userId",member))))
            .andExpect(status().isCreated());
        UUID newMembership = jdbc.queryForObject("""
            SELECT id FROM meeting_participants WHERE meeting_id=? AND user_id=?
                AND removed_at IS NULL
            """, UUID.class, meeting, member);
        assertThat(newMembership).isNotEqualTo(oldMembership);
        assertThat(count(meeting,"MEETING_PARTICIPANT_ADDED")).isEqualTo(3);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM audit_events WHERE meeting_id=? AND entity_id=?
            """,Integer.class,meeting, newMembership)).isEqualTo(1);
    }

    @Test void rejectedWritesAndRoomConflictNeverProduceSuccessAudit() throws Exception {
        UUID room = room();
        MvcResult first = create(owner, Map.of("title","Room one",
            "roomId",room,"scheduledStartAt",NINE,"scheduledEndAt",TEN));
        MvcResult second = create(outsider, Map.of("title","Room two",
            "roomId",room,"scheduledStartAt",NINE,"scheduledEndAt",TEN));
        UUID firstId = id(first), secondId = id(second);
        schedule(firstId,owner,tag(first));
        int before = total(secondId);
        mvc.perform(post("/api/v1/meetings/" + secondId + "/schedule")
            .principal(principal(outsider)).header(HttpHeaders.IF_MATCH,tag(second)))
            .andExpect(status().isConflict());
        assertThat(total(secondId)).isEqualTo(before);
        assertThat(count(secondId,"MEETING_SCHEDULED")).isZero();
        assertThat(jdbc.queryForObject("SELECT status FROM meetings WHERE id=?",
            String.class,secondId)).isEqualTo("DRAFT");

        mvc.perform(patch("/api/v1/meetings/" + firstId)
            .principal(principal(outsider)).header(HttpHeaders.IF_MATCH,tag(first))
            .contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"Attack\"}"))
            .andExpect(status().isNotFound());
        mvc.perform(patch("/api/v1/meetings/" + firstId)
            .principal(principal(admin)).header(HttpHeaders.IF_MATCH,tag(first))
            .contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"Admin attack\"}"))
            .andExpect(status().isNotFound());
        mvc.perform(patch("/api/v1/meetings/" + firstId)
            .principal(principal(owner)).header(HttpHeaders.IF_MATCH,tag(first))
            .contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"Stale\"}"))
            .andExpect(status().isPreconditionFailed());
        assertThat(count(firstId,"MEETING_UPDATED")).isZero();
    }

    @Test void allLifecycleTransitionsAreAuditedButCancellationDoesNotLeakReason()
            throws Exception {
        MvcResult draft = create(owner,Map.of("title","Lifecycle"));
        UUID meeting = id(draft);
        MvcResult scheduled = mvc.perform(post("/api/v1/meetings/" + meeting + "/schedule")
            .principal(principal(owner)).header(HttpHeaders.IF_MATCH,tag(draft))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("scheduledStartAt",NINE,"scheduledEndAt",TEN))))
            .andExpect(status().isOk()).andReturn();
        MvcResult started = mvc.perform(post("/api/v1/meetings/" + meeting + "/start")
            .principal(principal(owner)).header(HttpHeaders.IF_MATCH,tag(scheduled)))
            .andExpect(status().isOk()).andReturn();
        mvc.perform(post("/api/v1/meetings/" + meeting + "/end")
            .principal(principal(owner)).header(HttpHeaders.IF_MATCH,tag(started)))
            .andExpect(status().isOk());
        assertThat(count(meeting,"MEETING_STARTED")).isEqualTo(1);
        assertThat(count(meeting,"MEETING_ENDED")).isEqualTo(1);
        assertThat(event(meeting,"MEETING_ENDED").path("toStatus").asText()).isEqualTo("ENDED");

        MvcResult another = create(owner,Map.of("title","Draft cancellation"));
        UUID cancelled = id(another);
        mvc.perform(post("/api/v1/meetings/" + cancelled + "/cancel")
            .principal(principal(owner)).header(HttpHeaders.IF_MATCH,tag(another))
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"reason\":\"Sensitive personal discussion\"}"))
            .andExpect(status().isOk());
        assertThat(event(cancelled,"MEETING_CANCELLED").path("fromStatus").asText())
            .isEqualTo("DRAFT");
        assertThat(event(cancelled,"MEETING_CANCELLED").toString())
            .doesNotContain("Sensitive personal discussion");
    }

    @Test void auditWriterRejectsStandaloneTransaction() {
        assertThatThrownBy(() -> writer.record(owner,"MEETING_UPDATED","MEETING",
            UUID.randomUUID(),UUID.randomUUID(), Map.of("outcome","SUCCESS")))
            .isInstanceOf(IllegalTransactionStateException.class);
    }
}
