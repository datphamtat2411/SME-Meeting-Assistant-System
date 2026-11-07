package com.sme.meetingassistant.api.actionitems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.actionitems.application.ActionItemProposalPort;
import com.sme.meetingassistant.api.actionitems.dto.ActionItemProposal;
import com.sme.meetingassistant.api.userorganization.entity.AccountStatus;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import java.security.Principal;
import java.time.LocalDate;
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
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
@Transactional
class ActionItemsIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired UserRepository users;
    @Autowired JdbcTemplate jdbc;
    @Autowired ActionItemProposalPort proposals;

    UserEntity organizer;
    UserEntity assignee;
    UserEntity outsider;
    UUID meetingId;

    @BeforeEach void setup() throws Exception {
        organizer = user();
        assignee = user();
        outsider = user();
        MvcResult created = mvc.perform(post("/api/v1/meetings").principal(principal(organizer))
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("title", "Action item test",
                    "participantUserIds", java.util.List.of(assignee.getId())))))
            .andExpect(status().isCreated()).andReturn();
        meetingId = UUID.fromString(body(created).path("data").path("id").asText());
    }

    @Test void manualActionItemRequiresMeetingParticipantAndSupportsVersionedCompletion() throws Exception {
        MvcResult created = mvc.perform(post("/api/v1/action-items").principal(principal(organizer))
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("meetingId", meetingId,
                    "title", "Send the project brief", "assigneeUserId", assignee.getId()))))
            .andExpect(status().isCreated()).andReturn();

        JsonNode item = body(created).path("data");
        UUID id = UUID.fromString(item.path("id").asText());
        assertThat(item.path("status").asText()).isEqualTo("OPEN");
        assertThat(item.path("assigneeUserId").asText()).isEqualTo(assignee.getId().toString());
        String etag = created.getResponse().getHeader(HttpHeaders.ETAG);
        assertThat(etag).isNotBlank();

        mvc.perform(post("/api/v1/action-items/{id}/complete", id).principal(principal(assignee))
                .header(HttpHeaders.IF_MATCH, "\"stale\""))
            .andExpect(status().isPreconditionFailed());
        mvc.perform(post("/api/v1/action-items/{id}/complete", id).principal(principal(assignee))
                .header(HttpHeaders.IF_MATCH, etag))
            .andExpect(status().isOk());

        assertThat(jdbc.queryForObject("SELECT status FROM action_items WHERE id=?", String.class, id))
            .isEqualTo("DONE");
        assertThat(jdbc.queryForObject("SELECT count(*) FROM action_item_history WHERE action_item_id=?",
            Integer.class, id)).isEqualTo(3);
    }

    @Test void schemaUsesCanonicalStatusesAndDoesNotPersistOverdueState() {
        assertThat(jdbc.queryForList("""
            SELECT check_clause FROM information_schema.check_constraints
             WHERE constraint_name='ck_action_items_status'
            """, String.class)).singleElement().asString()
            .doesNotContain("OVERDUE");
        assertThat(jdbc.queryForList("""
            SELECT column_name FROM information_schema.columns
             WHERE table_schema='public' AND table_name='action_items'
            """, String.class)).contains("version", "due_date", "completed_by_user_id", "completed_at");
    }

    @Test void currentAssigneeCanReadOnlyTheirAssignedItemWithoutMeetingMembership() throws Exception {
        UserEntity externalAssignee = user();
        UUID id = createManual(externalAssignee.getId(), null);

        mvc.perform(get("/api/v1/action-items/{id}", id).principal(principal(externalAssignee)))
            .andExpect(status().isOk());
        mvc.perform(get("/api/v1/action-items/{id}", id).principal(principal(outsider)))
            .andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/action-items").principal(principal(externalAssignee))
                .param("assignee", "me"))
            .andExpect(status().isOk());
    }

    @Test void overdueIsDerivedAndDoesNotChangeCanonicalStatus() throws Exception {
        UUID id = createManual(assignee.getId(), LocalDate.now().minusDays(1));

        MvcResult result = mvc.perform(get("/api/v1/action-items/{id}", id).principal(principal(organizer)))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(result).path("data").path("status").asText()).isEqualTo("OPEN");
        assertThat(body(result).path("data").path("overdue").asBoolean()).isTrue();
        mvc.perform(get("/api/v1/action-items").principal(principal(organizer)).param("overdue", "true"))
            .andExpect(status().isOk());
    }

    @Test void aiProposalRemainsProposedUntilAssigneeIsSetAndHumanConfirms() throws Exception {
        UUID mediaId = UUID.randomUUID();
        UUID jobId = UUID.randomUUID();
        UUID transcriptId = UUID.randomUUID();
        UUID segmentId = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,content_type,
                expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?, 'audio/wav',10,10,1000,?,CURRENT_TIMESTAMP)
            """, mediaId, meetingId, "action-items/final/" + mediaId,
            "action-items/pending/" + mediaId, organizer.getId());
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,status,requested_by_user_id,queued_at)
            VALUES (?,?,?,'QUEUED',?,CURRENT_TIMESTAMP)
            """, jobId, meetingId, mediaId, organizer.getId());
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,version_number,
                language_code,status,is_current,duration_ms,finalized_at)
            VALUES (?,?,?,?,1,'en','READY',true,1000,CURRENT_TIMESTAMP)
            """, transcriptId, meetingId, mediaId, jobId);
        jdbc.update("""
            INSERT INTO transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,current_text,quality_status)
            VALUES (?,?,0,0,1000,'Send the brief','ACCEPTED')
            """, segmentId, transcriptId);

        var proposal = proposals.propose(new ActionItemProposal(meetingId, jobId, "candidate-1",
            "Send the project brief", null, null, null, List.of(segmentId)));
        assertThat(proposal.status()).isEqualTo(ActionItemStatus.PROPOSED);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM action_item_evidence WHERE action_item_id=?",
            Integer.class, proposal.id())).isEqualTo(1);

        String tag = ActionItemEtags.of(proposal);
        mvc.perform(post("/api/v1/action-items/{id}/confirm", proposal.id()).principal(principal(organizer))
                .header(HttpHeaders.IF_MATCH, tag))
            .andExpect(status().isUnprocessableEntity());

        MvcResult assigned = mvc.perform(patch("/api/v1/action-items/{id}", proposal.id())
                .principal(principal(organizer)).header(HttpHeaders.IF_MATCH, tag)
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("assigneeUserId", assignee.getId()))))
            .andExpect(status().isOk()).andReturn();
        mvc.perform(post("/api/v1/action-items/{id}/confirm", proposal.id()).principal(principal(organizer))
                .header(HttpHeaders.IF_MATCH, assigned.getResponse().getHeader(HttpHeaders.ETAG)))
            .andExpect(status().isOk());
        assertThat(jdbc.queryForObject("SELECT status FROM action_items WHERE id=?", String.class, proposal.id()))
            .isEqualTo("OPEN");
    }

    @Test void departmentManagerSeesAndManagesOnlyActionItemsWithinGrantedOrganizerUnit() throws Exception {
        UUID unitId = UUID.randomUUID();
        jdbc.update("INSERT INTO organizational_units(id,code,name,status) VALUES (?,?,?,'ACTIVE')",
            unitId, "AI-" + unitId, "Action Item Scope");
        organizer.assignPrimaryOrgUnit(unitId);
        users.saveAndFlush(organizer);
        UserEntity manager = user(GlobalRole.DEPARTMENT_MANAGER, unitId);
        jdbc.update("INSERT INTO manager_scope_units(user_id,org_unit_id,granted_by_user_id) VALUES (?,?,?)",
            manager.getId(), unitId, organizer.getId());
        UUID id = createManual(assignee.getId(), null);

        MvcResult list = mvc.perform(get("/api/v1/action-items").principal(principal(manager)))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(list).path("data").toString()).contains(id.toString());
        MvcResult detail = mvc.perform(get("/api/v1/action-items/{id}", id).principal(principal(manager)))
            .andExpect(status().isOk()).andReturn();
        mvc.perform(post("/api/v1/action-items/{id}/cancel", id).principal(principal(manager))
                .header(HttpHeaders.IF_MATCH, detail.getResponse().getHeader(HttpHeaders.ETAG)))
            .andExpect(status().isOk());
    }

    private UUID createManual(UUID assigneeId, LocalDate dueDate) throws Exception {
        Map<String, Object> request = new java.util.HashMap<>();
        request.put("meetingId", meetingId);
        request.put("title", "Send the project brief");
        request.put("assigneeUserId", assigneeId);
        if (dueDate != null) request.put("dueDate", dueDate.toString());
        MvcResult result = mvc.perform(post("/api/v1/action-items").principal(principal(organizer))
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(request)))
            .andExpect(status().isCreated()).andReturn();
        return UUID.fromString(body(result).path("data").path("id").asText());
    }

    private UserEntity user() {
        return user(GlobalRole.EMPLOYEE, null);
    }
    private UserEntity user(GlobalRole role, UUID unitId) {
        UserEntity user = new UserEntity("action-" + UUID.randomUUID() + "@example.invalid",
            "Action Test", role, unitId);
        ReflectionTestUtils.setField(user, "accountStatus", AccountStatus.ACTIVE);
        ReflectionTestUtils.setField(user, "passwordHash", "test-only-hash");
        return users.saveAndFlush(user);
    }
    private static Principal principal(UserEntity user) { return () -> user.getId().toString(); }
    private JsonNode body(MvcResult result) throws Exception {
        return json.readTree(result.getResponse().getContentAsString());
    }
}
