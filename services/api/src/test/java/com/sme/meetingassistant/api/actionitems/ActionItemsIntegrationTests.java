package com.sme.meetingassistant.api.actionitems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.actionitem.service.ActionItemBatchFingerprint;
import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink;
import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink.Batch;
import com.sme.meetingassistant.api.actionitem.service.ActionItemProposalSink.Candidate;
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
    @Autowired ActionItemProposalSink sink;

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

    @Test void departmentManagerSeesAndManagesOnlyActionItemsWithinGrantedOrganizerUnit() throws Exception {
        UUID unitId = UUID.randomUUID();
        jdbc.update("INSERT INTO organizational_units(id,code,name,status) VALUES (?,?,?,'ACTIVE')",
            unitId, "AI-" + unitId, "Action Item Scope");
        organizer.assignPrimaryOrgUnit(unitId);
        users.saveAndFlush(organizer);
        UserEntity manager = user(GlobalRole.DEPARTMENT_MANAGER, unitId);
        jdbc.update("INSERT INTO manager_scope_units(user_id,org_unit_id,granted_by_user_id) VALUES (?,?,?)",
            manager.getId(), unitId, organizer.getId());
        // Scope is captured by Meeting when a NEW meeting is created.
        // Changing an organizer's current unit cannot backfill old meetings.
        meetingId = newMeeting(List.of(assignee.getId()));
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

    @Test void proposalAssigneeHintGrantsNoAccessBeforeOrAfterRejection() throws Exception {
        UUID proposal = createAiProposal();
        MvcResult original = mvc.perform(get("/api/v1/action-items/{id}", proposal)
            .principal(principal(organizer))).andExpect(status().isOk()).andReturn();
        MvcResult hinted = mvc.perform(patch("/api/v1/action-items/{id}", proposal)
                .principal(principal(organizer))
                .header(HttpHeaders.IF_MATCH, original.getResponse().getHeader(HttpHeaders.ETAG))
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("assigneeUserId", outsider.getId()))))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(hinted).path("data").path("status").asText()).isEqualTo("PROPOSED");

        mvc.perform(get("/api/v1/action-items/{id}", proposal).principal(principal(outsider)))
            .andExpect(status().isNotFound());
        MvcResult list = mvc.perform(get("/api/v1/action-items").principal(principal(outsider))
                .param("assignee","me").param("meetingId",meetingId.toString())
                .param("q","Gửi báo cáo quý").param("page","0").param("size","1"))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(list).path("data").size()).isZero();
        assertThat(body(list).path("meta").path("pagination").path("totalElements").asLong()).isZero();
        mvc.perform(post("/api/v1/action-items/{id}/start", proposal)
                .principal(principal(outsider))
                .header(HttpHeaders.IF_MATCH, hinted.getResponse().getHeader(HttpHeaders.ETAG)))
            .andExpect(status().isNotFound());

        mvc.perform(post("/api/v1/action-items/{id}/reject", proposal)
                .principal(principal(organizer))
                .header(HttpHeaders.IF_MATCH, hinted.getResponse().getHeader(HttpHeaders.ETAG)))
            .andExpect(status().isOk());
        mvc.perform(get("/api/v1/action-items/{id}", proposal).principal(principal(outsider)))
            .andExpect(status().isNotFound());
        MvcResult rejected = mvc.perform(get("/api/v1/action-items")
                .principal(principal(outsider)).param("assignee", "me"))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(rejected).path("meta").path("pagination")
            .path("totalElements").asLong()).isZero();
    }

    @Test void confirmedAssigneeCanFilterOwnMeetingWorkButCannotReadMeetingProvenance() throws Exception {
        UUID proposal = createAiProposal();
        MvcResult original = mvc.perform(get("/api/v1/action-items/{id}", proposal)
                .principal(principal(organizer))).andExpect(status().isOk()).andReturn();
        MvcResult hinted = mvc.perform(patch("/api/v1/action-items/{id}", proposal)
                .principal(principal(organizer))
                .header(HttpHeaders.IF_MATCH, original.getResponse().getHeader(HttpHeaders.ETAG))
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("assigneeUserId", outsider.getId()))))
            .andExpect(status().isOk()).andReturn();
        mvc.perform(post("/api/v1/action-items/{id}/confirm", proposal)
                .principal(principal(organizer))
                .header(HttpHeaders.IF_MATCH, hinted.getResponse().getHeader(HttpHeaders.ETAG)))
            .andExpect(status().isOk());
        MvcResult detail = mvc.perform(get("/api/v1/action-items/{id}",proposal)
                .principal(principal(outsider))).andExpect(status().isOk()).andReturn();
        JsonNode scoped = body(detail).path("data");
        assertThat(scoped.path("status").asText()).isEqualTo("OPEN");
        assertThat(scoped.path("processingJobId").isNull()).isTrue();
        assertThat(scoped.path("createdByUserId").isNull()).isTrue();
        assertThat(scoped.path("confirmedByUserId").isNull()).isTrue();
        assertThat(scoped.path("confirmedAt").isNull()).isTrue();

        MvcResult list = mvc.perform(get("/api/v1/action-items").principal(principal(outsider))
                .param("assignee", "me").param("meetingId",meetingId.toString())
                .param("status","OPEN").param("q","Gửi báo cáo").param("page","0").param("size","1"))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(list).path("meta").path("pagination").path("totalElements").asLong())
            .isEqualTo(1);
        assertThat(body(list).path("data").get(0).path("id").asText())
            .isEqualTo(proposal.toString());
        assertThat(body(list).path("data").get(0).path("processingJobId").isNull()).isTrue();
        mvc.perform(get("/api/v1/meetings/{meetingId}",meetingId)
                .principal(principal(outsider))).andExpect(status().isNotFound());
    }

    @Test void approvedManagerScopeIsStableAgainstOrganizerTransfersAndRevokedGrants() throws Exception {
        UUID unit1=unit(), unit2=unit();
        organizer.assignPrimaryOrgUnit(unit1);
        users.saveAndFlush(organizer);
        meetingId=newMeeting(List.of(assignee.getId()));
        UserEntity oldManager=user(GlobalRole.DEPARTMENT_MANAGER,unit1);
        UserEntity newManager=user(GlobalRole.DEPARTMENT_MANAGER,unit2);
        jdbc.update("INSERT INTO manager_scope_units(user_id,org_unit_id,granted_by_user_id) VALUES (?,?,?)",
            oldManager.getId(),unit1,organizer.getId());
        jdbc.update("INSERT INTO manager_scope_units(user_id,org_unit_id,granted_by_user_id) VALUES (?,?,?)",
            newManager.getId(),unit2,organizer.getId());
        UUID id=createManual(assignee.getId(),null);

        MvcResult item= mvc.perform(get("/api/v1/action-items/{id}",id)
                .principal(principal(oldManager))).andExpect(status().isOk()).andReturn();
        assertThat(body(item).path("data").path("createdByUserId").isNull()).isTrue();
        mvc.perform(get("/api/v1/meetings/{id}",meetingId).principal(principal(oldManager)))
            .andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/action-items/{id}",id).principal(principal(newManager)))
            .andExpect(status().isNotFound());

        // Current organizer location is irrelevant to old meeting classification.
        organizer.assignPrimaryOrgUnit(unit2);
        users.saveAndFlush(organizer);
        mvc.perform(get("/api/v1/action-items/{id}",id).principal(principal(oldManager)))
            .andExpect(status().isOk());
        mvc.perform(get("/api/v1/action-items/{id}",id).principal(principal(newManager)))
            .andExpect(status().isNotFound());

        jdbc.update("DELETE FROM manager_scope_units WHERE user_id=? AND org_unit_id=?",
            oldManager.getId(),unit1);
        mvc.perform(get("/api/v1/action-items/{id}",id).principal(principal(oldManager)))
            .andExpect(status().isNotFound());
        MvcResult noAccess=mvc.perform(get("/api/v1/action-items")
                .principal(principal(oldManager)).param("meetingId",meetingId.toString()))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(noAccess).path("meta").path("pagination").path("totalElements").asLong())
            .isZero();
    }

    @Test void oldUnscopedMeetingDoesNotGainManagerAccessFromDirectoryEdits() throws Exception {
        UUID unitId=unit();
        UserEntity manager=user(GlobalRole.DEPARTMENT_MANAGER,unitId);
        jdbc.update("INSERT INTO manager_scope_units(user_id,org_unit_id,granted_by_user_id) VALUES (?,?,?)",
            manager.getId(),unitId,organizer.getId());
        UUID task=createManual(assignee.getId(),null);
        // Meeting was created before its organizer belonged to any unit.
        organizer.assignPrimaryOrgUnit(unitId);
        users.saveAndFlush(organizer);
        mvc.perform(get("/api/v1/action-items/{id}",task).principal(principal(manager)))
            .andExpect(status().isNotFound());
        MvcResult listing=mvc.perform(get("/api/v1/action-items")
                .principal(principal(manager)).param("meetingId",meetingId.toString()))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(listing).path("meta").path("pagination").path("totalElements").asLong())
            .isZero();
    }

    @Test void revokedParticipantLosesMeetingContextAndUnassignedTaskVisibility() throws Exception {
        UUID task=createManual(outsider.getId(),null);
        mvc.perform(get("/api/v1/action-items/{id}",task).principal(principal(assignee)))
            .andExpect(status().isOk());
        jdbc.update("UPDATE meeting_participants SET removed_at=CURRENT_TIMESTAMP,removed_by_user_id=? WHERE meeting_id=? AND user_id=? AND removed_at IS NULL",
            organizer.getId(),meetingId,assignee.getId());
        mvc.perform(get("/api/v1/action-items/{id}",task).principal(principal(assignee)))
            .andExpect(status().isNotFound());
        MvcResult list=mvc.perform(get("/api/v1/action-items")
                .principal(principal(assignee)).param("page","0").param("size","1"))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(list).path("meta").path("pagination").path("totalElements").asLong())
            .isZero();
    }

    @Test void globalAdministratorWithoutMeetingRelationshipHasNoBlanketActionItemAccess() throws Exception {
        UserEntity admin=user(GlobalRole.ADMINISTRATOR,null);
        UUID id=createManual(assignee.getId(),null);
        mvc.perform(get("/api/v1/action-items/{id}",id).principal(principal(admin)))
            .andExpect(status().isNotFound());
        MvcResult listing=mvc.perform(get("/api/v1/action-items")
            .principal(principal(admin)).param("meetingId",meetingId.toString()))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(listing).path("meta").path("pagination").path("totalElements").asLong())
            .isZero();
        mvc.perform(post("/api/v1/action-items/{id}/cancel",id).principal(principal(admin))
                .header(HttpHeaders.IF_MATCH,"\"version:0\""))
            .andExpect(status().isNotFound());
    }

    @Test void externalAssigneeCanTransitionOfficialTaskButCommandResponsesStayScoped() throws Exception {
        UUID item=createManual(outsider.getId(),null);
        MvcResult before=mvc.perform(get("/api/v1/action-items/{id}",item)
                .principal(principal(outsider))).andExpect(status().isOk()).andReturn();
        assertThat(body(before).path("data").path("createdByUserId").isNull()).isTrue();
        MvcResult after=mvc.perform(post("/api/v1/action-items/{id}/start",item)
                .principal(principal(outsider))
                .header(HttpHeaders.IF_MATCH,before.getResponse().getHeader(HttpHeaders.ETAG)))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(after).path("data").path("status").asText()).isEqualTo("IN_PROGRESS");
        assertThat(body(after).path("data").path("createdByUserId").isNull()).isTrue();
        assertThat(body(after).path("data").path("completedByUserId").isNull()).isTrue();
        mvc.perform(get("/api/v1/meetings/{id}",meetingId)
                .principal(principal(outsider))).andExpect(status().isNotFound());
        MvcResult list=mvc.perform(get("/api/v1/action-items").principal(principal(outsider))
                .param("assignee","me").param("meetingId",meetingId.toString())
                .param("status","IN_PROGRESS")).andExpect(status().isOk()).andReturn();
        assertThat(body(list).path("meta").path("pagination").path("totalElements").asLong())
            .isEqualTo(1);
        assertThat(body(list).path("data").get(0).path("createdByUserId").isNull()).isTrue();
    }

    @Test void scopedManagerCommandResponsesHideMeetingProvenanceAndNonManagersGetNoDelegation()
            throws Exception {
        UUID unitId=unit();
        organizer.assignPrimaryOrgUnit(unitId);
        users.saveAndFlush(organizer);
        meetingId=newMeeting(List.of(assignee.getId()));
        UUID id=createManual(assignee.getId(),null);
        UserEntity manager=user(GlobalRole.DEPARTMENT_MANAGER,unitId);
        UserEntity employeeWithGrant=user(GlobalRole.EMPLOYEE,unitId);
        jdbc.update("INSERT INTO manager_scope_units(user_id,org_unit_id,granted_by_user_id) VALUES (?,?,?)",
            manager.getId(),unitId,organizer.getId());
        jdbc.update("INSERT INTO manager_scope_units(user_id,org_unit_id,granted_by_user_id) VALUES (?,?,?)",
            employeeWithGrant.getId(),unitId,organizer.getId());
        mvc.perform(get("/api/v1/action-items/{id}",id).principal(principal(employeeWithGrant)))
            .andExpect(status().isNotFound());
        MvcResult old=mvc.perform(get("/api/v1/action-items/{id}",id)
                .principal(principal(manager))).andExpect(status().isOk()).andReturn();
        MvcResult cancelled=mvc.perform(post("/api/v1/action-items/{id}/cancel",id)
                .principal(principal(manager))
                .header(HttpHeaders.IF_MATCH,old.getResponse().getHeader(HttpHeaders.ETAG)))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(cancelled).path("data").path("createdByUserId").isNull()).isTrue();
        assertThat(body(cancelled).path("data").path("cancelledByUserId").isNull()).isTrue();

        manager.assignGlobalRole(GlobalRole.EMPLOYEE);
        users.saveAndFlush(manager);
        mvc.perform(get("/api/v1/action-items/{id}",id).principal(principal(manager)))
            .andExpect(status().isNotFound());
        MvcResult lost=mvc.perform(get("/api/v1/action-items")
                .principal(principal(manager)).param("meetingId",meetingId.toString()))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(lost).path("meta").path("pagination").path("totalElements").asLong())
            .isZero();
    }

    @Test void deactivatedOrganizationalUnitImmediatelyRevokesManagementPower() throws Exception {
        UUID unitId=unit();
        organizer.assignPrimaryOrgUnit(unitId);
        users.saveAndFlush(organizer);
        meetingId=newMeeting(List.of(assignee.getId()));
        UUID id=createManual(assignee.getId(),null);
        UserEntity manager=user(GlobalRole.DEPARTMENT_MANAGER,unitId);
        jdbc.update("INSERT INTO manager_scope_units(user_id,org_unit_id,granted_by_user_id) VALUES (?,?,?)",
            manager.getId(),unitId,organizer.getId());
        mvc.perform(get("/api/v1/action-items/{id}",id).principal(principal(manager)))
            .andExpect(status().isOk());
        jdbc.update("UPDATE organizational_units SET status='INACTIVE' WHERE id=?",unitId);
        mvc.perform(get("/api/v1/action-items/{id}",id).principal(principal(manager)))
            .andExpect(status().isNotFound());
        MvcResult list=mvc.perform(get("/api/v1/action-items")
                .principal(principal(manager)).param("meetingId",meetingId.toString()))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(list).path("meta").path("pagination").path("totalElements").asLong())
            .isZero();
    }

    @Test void capturedMeetingScopeCannotBeUpdatedBySqlWithoutExplicitReclassification() throws Exception {
        UUID unit1=unit(), unit2=unit();
        organizer.assignPrimaryOrgUnit(unit1);
        users.saveAndFlush(organizer);
        meetingId=newMeeting(List.of());
        assertThat(jdbc.queryForObject(
            "SELECT org_unit_id FROM meeting_action_item_scopes WHERE meeting_id=?",
            UUID.class,meetingId)).isEqualTo(unit1);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> jdbc.update(
            "UPDATE meeting_action_item_scopes SET org_unit_id=? WHERE meeting_id=?",
            unit2,meetingId)).isInstanceOf(
                org.springframework.dao.DataIntegrityViolationException.class);
    }

    @Test void commandIdentityPreventsAccidentalConfirmReopenOrRejectCancel() throws Exception {
        UUID manual=createManual(assignee.getId(),null);
        MvcResult created=mvc.perform(get("/api/v1/action-items/{id}",manual)
                .principal(principal(organizer))).andExpect(status().isOk()).andReturn();
        String etag=created.getResponse().getHeader(HttpHeaders.ETAG);
        mvc.perform(post("/api/v1/action-items/{id}/confirm",manual)
                .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,etag))
            .andExpect(status().isConflict());
        mvc.perform(post("/api/v1/action-items/{id}/reject",manual)
                .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,etag))
            .andExpect(status().isConflict());
        mvc.perform(post("/api/v1/action-items/{id}/reopen",manual)
                .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,etag))
            .andExpect(status().isConflict());

        MvcResult done=mvc.perform(post("/api/v1/action-items/{id}/complete",manual)
                .principal(principal(assignee)).header(HttpHeaders.IF_MATCH,etag))
            .andExpect(status().isOk()).andReturn();
        String doneTag=done.getResponse().getHeader(HttpHeaders.ETAG);
        mvc.perform(post("/api/v1/action-items/{id}/confirm",manual)
                .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,doneTag))
            .andExpect(status().isConflict());
        mvc.perform(post("/api/v1/action-items/{id}/start",manual)
                .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,doneTag))
            .andExpect(status().isConflict());
        MvcResult reopened=mvc.perform(post("/api/v1/action-items/{id}/reopen",manual)
                .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,doneTag))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(reopened).path("data").path("status").asText()).isEqualTo("OPEN");
        assertThat(body(reopened).path("data").path("completedByUserId").isNull()).isTrue();
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM action_item_history WHERE action_item_id=? AND change_type='STATUS'",
            Integer.class,manual)).isEqualTo(3); // OPEN(create), DONE, OPEN(reopen)
        assertThat(jdbc.queryForObject(
            "SELECT status FROM action_items WHERE id=?",String.class,manual)).isEqualTo("OPEN");

        UUID proposal=createAiProposal();
        MvcResult initial=mvc.perform(get("/api/v1/action-items/{id}",proposal)
                .principal(principal(organizer))).andExpect(status().isOk()).andReturn();
        String proposedTag=initial.getResponse().getHeader(HttpHeaders.ETAG);
        mvc.perform(post("/api/v1/action-items/{id}/reopen",proposal)
                .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,proposedTag))
            .andExpect(status().isConflict());
        mvc.perform(post("/api/v1/action-items/{id}/cancel",proposal)
                .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,proposedTag))
            .andExpect(status().isConflict());
        mvc.perform(post("/api/v1/action-items/{id}/start",proposal)
                .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,proposedTag))
            .andExpect(status().isConflict());
        mvc.perform(post("/api/v1/action-items/{id}/confirm",proposal)
                .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,proposedTag))
            .andExpect(status().isUnprocessableEntity()); // missing owner
        MvcResult rejected=mvc.perform(post("/api/v1/action-items/{id}/reject",proposal)
                .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,proposedTag))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(rejected).path("data").path("status").asText()).isEqualTo("CANCELLED");
        mvc.perform(post("/api/v1/action-items/{id}/confirm",proposal)
                .principal(principal(organizer))
                .header(HttpHeaders.IF_MATCH,rejected.getResponse().getHeader(HttpHeaders.ETAG)))
            .andExpect(status().isConflict());
    }

    @Test void typedPatchDistinguishesOmittedFieldNullClearAndNoOpWithoutForgedHistory()
            throws Exception {
        UUID item=createManual(assignee.getId(),LocalDate.parse("2026-12-25"));
        MvcResult initial=mvc.perform(get("/api/v1/action-items/{id}",item)
                .principal(principal(organizer))).andExpect(status().isOk()).andReturn();
        String tag=initial.getResponse().getHeader(HttpHeaders.ETAG);
        int historyBefore=jdbc.queryForObject(
            "SELECT count(*) FROM action_item_history WHERE action_item_id=?",
            Integer.class,item);
        MvcResult noOp=mvc.perform(patch("/api/v1/action-items/{id}",item)
                .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,tag)
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("title","Send the project brief"))))
            .andExpect(status().isOk()).andReturn();
        assertThat(noOp.getResponse().getHeader(HttpHeaders.ETAG)).isEqualTo(tag);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM action_item_history WHERE action_item_id=?",
            Integer.class,item)).isEqualTo(historyBefore);

        MvcResult details=mvc.perform(patch("/api/v1/action-items/{id}",item)
                .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,tag)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"details\":\"Team details\\nLine two\"}"))
            .andExpect(status().isOk()).andReturn();
        String v1=details.getResponse().getHeader(HttpHeaders.ETAG);
        assertThat(v1).isNotEqualTo(tag);
        assertThat(body(details).path("data").path("dueDate").asText()).isEqualTo("2026-12-25");
        MvcResult cleared=mvc.perform(patch("/api/v1/action-items/{id}",item)
                .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,v1)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"details\":null,\"dueDate\":null}"))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(cleared).path("data").path("details").isNull()).isTrue();
        assertThat(body(cleared).path("data").path("dueDate").isNull()).isTrue();
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM action_item_history WHERE action_item_id=? AND change_type='CONTENT'",
            Integer.class,item)).isEqualTo(2);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM action_item_history WHERE action_item_id=? AND change_type='DUE_DATE'",
            Integer.class,item)).isEqualTo(2);
        mvc.perform(patch("/api/v1/action-items/{id}",item)
                .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,tag)
                .contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"Lost write\"}"))
            .andExpect(status().isPreconditionFailed());
    }

    @Test void typedPatchRejectsUnknownOrMistypedFieldsAndActiveAssignmentCannotClear()
            throws Exception {
        UUID item=createManual(assignee.getId(),null);
        String tag=mvc.perform(get("/api/v1/action-items/{id}",item)
                .principal(principal(organizer))).andReturn().getResponse()
            .getHeader(HttpHeaders.ETAG);
        for (String bad : List.of(
            "{}", "[]", "{\"title\":null}", "{\"details\":42}",
            "{\"dueDate\":123}", "{\"dueDate\":\"yesterday\"}",
            "{\"assigneeUserId\":false}", "{\"priority\":\"HIGH\"}",
            "{\"title\":\"Nice\",\"processingJobId\":\"forged\"}",
            "{\"title\":\"Broken\\ncontrol\"}", "{\"details\":\"bad\\u001b\"}",
            "{\"assigneeUserId\":null}")) {
            mvc.perform(patch("/api/v1/action-items/{id}",item)
                    .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,tag)
                    .contentType(MediaType.APPLICATION_JSON).content(bad))
                .andExpect(status().isUnprocessableEntity());
        }
        mvc.perform(patch("/api/v1/action-items/{id}",item)
                .principal(principal(organizer))
                .contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"x\"}"))
            .andExpect(status().isPreconditionRequired());
        assertThat(jdbc.queryForObject(
            "SELECT version FROM action_items WHERE id=?",Long.class,item)).isZero();
    }

    @Test void createManualWithIdempotencyKeyReplaysCurrentResourceAndRejectsDifferentIntent()
            throws Exception {
        String key="ai05-"+UUID.randomUUID();
        Map<String,Object> payload=Map.of("meetingId",meetingId,
            "title","Retry safe manual work","assigneeUserId",assignee.getId());
        MvcResult first=mvc.perform(post("/api/v1/action-items")
                .principal(principal(organizer)).header("Idempotency-Key",key)
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(payload)))
            .andExpect(status().isCreated()).andReturn();
        UUID id=UUID.fromString(body(first).path("data").path("id").asText());
        MvcResult again=mvc.perform(post("/api/v1/action-items")
                .principal(principal(organizer)).header("Idempotency-Key",key)
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(payload)))
            .andExpect(status().isCreated()).andReturn();
        assertThat(body(again).path("data").path("id").asText()).isEqualTo(id.toString());
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM action_items WHERE id=?",Integer.class,id)).isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM action_item_history WHERE action_item_id=?",
            Integer.class,id)).isEqualTo(2);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM action_item_creation_idempotency WHERE actor_user_id=?",
            Integer.class,organizer.getId())).isEqualTo(1);

        MvcResult edited=mvc.perform(patch("/api/v1/action-items/{id}",id)
                .principal(principal(organizer))
                .header(HttpHeaders.IF_MATCH,first.getResponse().getHeader(HttpHeaders.ETAG))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"title\":\"Human revised task\"}"))
            .andExpect(status().isOk()).andReturn();
        MvcResult replay=mvc.perform(post("/api/v1/action-items")
                .principal(principal(organizer)).header("Idempotency-Key",key)
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(payload)))
            .andExpect(status().isCreated()).andReturn();
        assertThat(body(replay).path("data").path("title").asText())
            .isEqualTo("Human revised task");
        assertThat(replay.getResponse().getHeader(HttpHeaders.ETAG))
            .isEqualTo(edited.getResponse().getHeader(HttpHeaders.ETAG));
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM action_item_history WHERE action_item_id=?",
            Integer.class,id)).isEqualTo(3);

        Map<String,Object> changed=Map.of("meetingId",meetingId,"title","Different intent",
            "assigneeUserId",assignee.getId());
        mvc.perform(post("/api/v1/action-items")
                .principal(principal(organizer)).header("Idempotency-Key",key)
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(changed)))
            .andExpect(status().isConflict());
    }

    @Test void invalidCreateDoesNotConsumeIdempotencyKeyAndExpiredKeyCanBeReused()
            throws Exception {
        String key="ai05-expiry-"+UUID.randomUUID();
        String fresh="ai05-bad-"+UUID.randomUUID();
        mvc.perform(post("/api/v1/action-items").principal(principal(organizer))
                .header("Idempotency-Key",fresh).contentType(MediaType.APPLICATION_JSON)
                .content("{\"meetingId\":\""+meetingId+"\",\"title\":\"bad\\ncontrol\","
                    +"\"assigneeUserId\":\""+assignee.getId()+"\"}"))
            .andExpect(status().isUnprocessableEntity());
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM action_item_creation_idempotency WHERE actor_user_id=?",
            Integer.class,organizer.getId())).isZero();

        Map<String,Object> good=Map.of("meetingId",meetingId,"title","After rejected create",
            "assigneeUserId",assignee.getId());
        MvcResult first=mvc.perform(post("/api/v1/action-items")
                .principal(principal(organizer)).header("Idempotency-Key",fresh)
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(good)))
            .andExpect(status().isCreated()).andReturn();
        UUID old=UUID.fromString(body(first).path("data").path("id").asText());
        jdbc.update("""
            UPDATE action_item_creation_idempotency
               SET created_at=CURRENT_TIMESTAMP-INTERVAL '48 hours',
                   expires_at=CURRENT_TIMESTAMP-INTERVAL '24 hours'
             WHERE actor_user_id=?
            """,organizer.getId());
        MvcResult second=mvc.perform(post("/api/v1/action-items")
                .principal(principal(organizer)).header("Idempotency-Key",fresh)
                .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(good)))
            .andExpect(status().isCreated()).andReturn();
        assertThat(body(second).path("data").path("id").asText()).isNotEqualTo(old.toString());
    }

    private UUID unit() {
        UUID id=UUID.randomUUID();
        jdbc.update("INSERT INTO organizational_units(id,code,name,status) VALUES (?,?,?,'ACTIVE')",
            id,"AI-SCOPE-"+id,"Action item scope test");
        return id;
    }

    private UUID newMeeting(List<UUID> members) throws Exception {
        MvcResult created=mvc.perform(post("/api/v1/meetings").principal(principal(organizer))
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("title","Scoped meeting",
                    "participantUserIds",members))))
            .andExpect(status().isCreated()).andReturn();
        return UUID.fromString(body(created).path("data").path("id").asText());
    }

    /** Seed a valid provenance lineage and use the REAL canonical transactional AI sink. */
    private UUID createAiProposal() throws Exception {
        UUID media=UUID.randomUUID(), job=UUID.randomUUID(), transcript=UUID.randomUUID();
        UUID segment=UUID.randomUUID(), snapshot=UUID.randomUUID(), stage=UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',100,100,10000,?,CURRENT_TIMESTAMP)
            """,media,meetingId,"meetings/"+meetingId+"/sources/"+media,
            "meetings/"+meetingId+"/pending/"+media,organizer.getId());
        jdbc.update("""
            INSERT INTO processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status)
            VALUES (?,?,?,?,'RUNNING')
            """,job,meetingId,media,organizer.getId());
        jdbc.update("""
            INSERT INTO transcripts(id,meeting_id,source_media_id,processing_job_id,version_number,
                language_code,status,is_current,content_revision)
            VALUES (?,?,?,?,1,'vi','READY',TRUE,3)
            """,transcript,meetingId,media,job);
        jdbc.update("""
            INSERT INTO transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,current_text,quality_status)
            VALUES (?,?,0,0,1000,'AI proposal evidence','ACCEPTED')
            """,segment,transcript);
        jdbc.update("""
            INSERT INTO meeting_intelligence_source_snapshots(
                id,meeting_id,source_media_id,processing_job_id,transcript_id,
                content_revision,sha256,object_key,size_bytes)
            VALUES (?,?,?,?,?,3,?,?,100)
            """,snapshot,meetingId,media,job,transcript,"a".repeat(64),
            "processing/"+job+"/intelligence/source/"+snapshot+".json");
        jdbc.update("""
            INSERT INTO processing_stage_runs(id,processing_job_id,stage_code,
                attempt_number,status,claim_token,lease_expires_at)
            VALUES (?,?,'EXTRACTING_ACTION_ITEMS',1,'RUNNING',?,CURRENT_TIMESTAMP+INTERVAL '1 hour')
            """,stage,job,UUID.randomUUID());
        List<Candidate> candidates=List.of(new Candidate("task-1","Gửi báo cáo quý",
            "Chờ người tổ chức xác nhận",LocalDate.parse("2026-11-08"),List.of(segment)));
        Batch batch=new Batch(meetingId,job,stage,snapshot,transcript,3,false,
            ActionItemBatchFingerprint.sha256(json,candidates),candidates);
        assertThat(sink.acceptProposed(batch).newProposals()).isEqualTo(1);
        return jdbc.queryForObject("SELECT id FROM action_items WHERE proposal_batch_id=("
            + "SELECT id FROM action_item_batch_receipts WHERE stage_run_id=?)",UUID.class,stage);
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
