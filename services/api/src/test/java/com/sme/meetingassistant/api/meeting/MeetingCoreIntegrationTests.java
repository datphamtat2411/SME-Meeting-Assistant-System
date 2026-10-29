package com.sme.meetingassistant.api.meeting;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.meeting.entity.MeetingStatus;
import com.sme.meetingassistant.api.meeting.repository.MeetingRepository;
import com.sme.meetingassistant.api.room.entity.RoomEntity;
import com.sme.meetingassistant.api.room.repository.RoomRepository;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.AccountStatus;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import java.security.Principal;
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
class MeetingCoreIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired UserRepository users;
    @Autowired RoomRepository rooms;
    @Autowired MeetingRepository meetings;
    @Autowired JdbcTemplate jdbc;

    UserEntity organizer, member, other, admin, pending;
    @BeforeEach void setup() {
        organizer = user(GlobalRole.EMPLOYEE,true);
        member = user(GlobalRole.EMPLOYEE,true);
        other = user(GlobalRole.EMPLOYEE,true);
        admin = user(GlobalRole.ADMINISTRATOR,true);
        pending = user(GlobalRole.EMPLOYEE,false);
    }
    private UserEntity user(GlobalRole role, boolean active) {
        UserEntity user = new UserEntity("meet-" + UUID.randomUUID() + "@example.invalid", "Test",role,null);
        if(active) {
            ReflectionTestUtils.setField(user,"accountStatus",AccountStatus.ACTIVE);
            ReflectionTestUtils.setField(user,"passwordHash","test-only-hash");
        }
        return users.saveAndFlush(user);
    }
    private static Principal principal(UserEntity user) { return () -> user.getId().toString(); }
    private JsonNode body(MvcResult r) throws Exception {
        return json.readTree(r.getResponse().getContentAsString());
    }
    private MvcResult create() throws Exception {
        return mvc.perform(post("/api/v1/meetings").principal(principal(organizer))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("title","Architecture review",
                "description","Decide milestone","participantUserIds",java.util.List.of(member.getId())))))
            .andExpect(status().isCreated()).andReturn();
    }
    private String etag(UUID id, UserEntity actor) throws Exception {
        return mvc.perform(get("/api/v1/meetings/"+id).principal(principal(actor)))
            .andExpect(status().isOk()).andReturn().getResponse().getHeader(HttpHeaders.ETAG);
    }

    @Test void draftCreationUsesCanonicalOrganizerAndPersistedParticipantAssociation() throws Exception {
        MvcResult created=create();
        JsonNode value=body(created).path("data");
        UUID id=UUID.fromString(value.path("id").asText());
        assertThat(value.path("status").asText()).isEqualTo("DRAFT");
        assertThat(value.path("organizerUserId").asText()).isEqualTo(organizer.getId().toString());
        assertThat(created.getResponse().getHeader(HttpHeaders.LOCATION)).isEqualTo("/api/v1/meetings/"+id);
        assertThat(created.getResponse().getHeader(HttpHeaders.ETAG)).isNotBlank();
        JsonNode list=body(mvc.perform(get("/api/v1/meetings/"+id+"/participants")
            .principal(principal(member))).andExpect(status().isOk()).andReturn()).path("data");
        assertThat(list).hasSize(2);
        assertThat(list.toString()).contains(organizer.getId().toString(),member.getId().toString());
        assertThat(meetings.findById(id).orElseThrow().getCreatedByUserId()).isEqualTo(organizer.getId());
    }

    @Test void organizerAndCurrentParticipantCanReadButOutsiderAndAdminCannot() throws Exception {
        String id=body(create()).path("data").path("id").asText();
        for(var actor:java.util.List.of(organizer,member)) {
            mvc.perform(get("/api/v1/meetings/"+id).principal(principal(actor)))
                .andExpect(status().isOk());
        }
        for(var actor:java.util.List.of(other,admin)) {
            mvc.perform(get("/api/v1/meetings/"+id).principal(principal(actor)))
                .andExpect(status().isNotFound());
            mvc.perform(get("/api/v1/meetings/"+id+"/participants").principal(principal(actor)))
                .andExpect(status().isNotFound());
        }
        mvc.perform(get("/api/v1/meetings/"+id)).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/v1/meetings/"+id).principal(principal(pending)))
            .andExpect(status().isUnauthorized());
    }

    @Test void listIsScopedBeforePaginationWithAuthorizedStatusTextAndDateFilters() throws Exception {
        String own=body(create()).path("data").path("id").asText();
        mvc.perform(post("/api/v1/meetings").principal(principal(other))
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"title\":\"Secret unrelated\"}")).andExpect(status().isCreated());
        MvcResult filtered=mvc.perform(get("/api/v1/meetings").principal(principal(member))
            .param("q","architecture").param("page","0").param("size","1"))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(filtered).path("meta").path("pagination").path("totalElements").asLong()).isEqualTo(1);
        assertThat(body(filtered).path("data").get(0).path("id").asText()).isEqualTo(own);
        mvc.perform(get("/api/v1/meetings").principal(principal(member)).param("status","ENDED"))
            .andExpect(status().isOk());
        mvc.perform(get("/api/v1/meetings").principal(principal(member)).param("size","101"))
            .andExpect(status().isUnprocessableEntity());
        mvc.perform(get("/api/v1/meetings").principal(principal(member)).param("sort","bad,asc"))
            .andExpect(status().isBadRequest());
    }

    @Test void scheduleStartEndAreVersionedAndGenerateDurableScheduleIntent() throws Exception {
        MvcResult created=create();
        String id=body(created).path("data").path("id").asText();
        String v0=created.getResponse().getHeader(HttpHeaders.ETAG);
        mvc.perform(post("/api/v1/meetings/"+id+"/schedule").principal(principal(organizer))
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"scheduledStartAt\":\"2030-06-01T09:00:00Z\",\"scheduledEndAt\":\"2030-06-01T10:00:00Z\"}"))
            .andExpect(status().is(428));
        MvcResult scheduled=mvc.perform(post("/api/v1/meetings/"+id+"/schedule")
            .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,v0)
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"scheduledStartAt\":\"2030-06-01T09:00:00Z\",\"scheduledEndAt\":\"2030-06-01T10:00:00Z\"}"))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(scheduled).path("data").path("status").asText()).isEqualTo("SCHEDULED");
        assertThat(body(scheduled).path("data").path("roomId").isNull()).isTrue();
        String v1=scheduled.getResponse().getHeader(HttpHeaders.ETAG);
        assertThat(v1).isNotEqualTo(v0);
        mvc.perform(post("/api/v1/meetings/"+id+"/start").principal(principal(organizer))
            .header(HttpHeaders.IF_MATCH,v0)).andExpect(status().isPreconditionFailed());
        Integer intent=jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries WHERE related_entity_id=? AND notification_type='MEETING_SCHEDULED'
            """,Integer.class,UUID.fromString(id));
        assertThat(intent).isEqualTo(2);
        MvcResult started=mvc.perform(post("/api/v1/meetings/"+id+"/start")
            .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,v1))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(started).path("data").path("startedAt").isTextual()).isTrue();
        MvcResult ended=mvc.perform(post("/api/v1/meetings/"+id+"/end")
            .principal(principal(organizer))
            .header(HttpHeaders.IF_MATCH,started.getResponse().getHeader(HttpHeaders.ETAG)))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(ended).path("data").path("status").asText()).isEqualTo("ENDED");
        assertThat(body(ended).path("data").path("endedAt").isTextual()).isTrue();
        assertThat(body(ended).path("data").path("scheduledStartAt").asText()).isEqualTo("2030-06-01T09:00:00Z");
    }

    @Test void scheduledRoomIsBlockedUntilReservationAuthorityExists() throws Exception {
        RoomEntity room=rooms.saveAndFlush(new RoomEntity("R-"+UUID.randomUUID(),"Briefing",null,10,null));
        MvcResult created=mvc.perform(post("/api/v1/meetings").principal(principal(organizer))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("title","Room draft", "roomId",room.getId(),
                "scheduledStartAt","2030-06-01T10:00:00Z",
                "scheduledEndAt","2030-06-01T11:00:00Z"))))
            .andExpect(status().isCreated()).andReturn();
        String id=body(created).path("data").path("id").asText();
        mvc.perform(post("/api/v1/meetings/"+id+"/schedule").principal(principal(organizer))
            .header(HttpHeaders.IF_MATCH,created.getResponse().getHeader(HttpHeaders.ETAG)))
            .andExpect(status().isConflict());
        assertThat(meetings.findById(UUID.fromString(id)).orElseThrow().getStatus())
            .isEqualTo(MeetingStatus.DRAFT);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM email_deliveries WHERE related_entity_id=?",
            Integer.class, UUID.fromString(id))).isZero();
    }

    @Test void patchIsPartialAndRequiresCurrentEtagAndMaterialScheduledEditsAreBlocked() throws Exception {
        MvcResult created=create(); String id=body(created).path("data").path("id").asText();
        String v0=created.getResponse().getHeader(HttpHeaders.ETAG);
        mvc.perform(patch("/api/v1/meetings/"+id).principal(principal(organizer))
            .contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"No tag\"}"))
            .andExpect(status().is(428));
        MvcResult updated=mvc.perform(patch("/api/v1/meetings/"+id)
            .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,v0)
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"title\":\"Updated title\",\"description\":null}"))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(updated).path("data").path("description").isNull()).isTrue();
        mvc.perform(patch("/api/v1/meetings/"+id).principal(principal(organizer))
            .header(HttpHeaders.IF_MATCH,v0).contentType(MediaType.APPLICATION_JSON)
            .content("{\"title\":\"Stale write\"}")).andExpect(status().isPreconditionFailed());
        mvc.perform(patch("/api/v1/meetings/"+id).principal(principal(organizer))
            .header(HttpHeaders.IF_MATCH,updated.getResponse().getHeader(HttpHeaders.ETAG))
            .contentType(MediaType.APPLICATION_JSON).content("{\"organizerUserId\":\""+other.getId()+"\"}"))
            .andExpect(status().isUnprocessableEntity());
    }

    @Test void participantRemovalRevokesAccessAndRetainsHistoryAndOrganizerCannotBeRemoved() throws Exception {
        MvcResult created=create(); String id=body(created).path("data").path("id").asText();
        String v0=created.getResponse().getHeader(HttpHeaders.ETAG);
        mvc.perform(delete("/api/v1/meetings/"+id+"/participants/"+organizer.getId())
            .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,v0))
            .andExpect(status().isConflict());
        mvc.perform(delete("/api/v1/meetings/"+id+"/participants/"+member.getId())
            .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,v0))
            .andExpect(status().isOk());
        mvc.perform(get("/api/v1/meetings/"+id).principal(principal(member)))
            .andExpect(status().isNotFound());
        JsonNode history=body(mvc.perform(get("/api/v1/meetings/"+id+"/participants")
            .principal(principal(organizer))).andExpect(status().isOk()).andReturn()).path("data");
        assertThat(history).hasSize(2);
        assertThat(history.toString()).contains("removedAt");
        mvc.perform(post("/api/v1/meetings/"+id+"/participants").principal(principal(organizer))
            .header(HttpHeaders.IF_MATCH,etag(UUID.fromString(id),organizer))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("userId",member.getId()))))
            .andExpect(status().isCreated());
        assertThat(body(mvc.perform(get("/api/v1/meetings/"+id+"/participants")
            .principal(principal(organizer))).andExpect(status().isOk()).andReturn()).path("data")).hasSize(3);
    }

    @Test void cancellationIsTerminalAndEmitsIntentWithoutDeletingMeeting() throws Exception {
        MvcResult created=create(); String id=body(created).path("data").path("id").asText();
        MvcResult scheduled=mvc.perform(post("/api/v1/meetings/"+id+"/schedule")
            .principal(principal(organizer))
            .header(HttpHeaders.IF_MATCH,created.getResponse().getHeader(HttpHeaders.ETAG))
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"scheduledStartAt\":\"2030-06-01T09:00:00Z\",\"scheduledEndAt\":\"2030-06-01T10:00:00Z\"}"))
            .andExpect(status().isOk()).andReturn();
        MvcResult cancelled=mvc.perform(post("/api/v1/meetings/"+id+"/cancel")
            .principal(principal(organizer))
            .header(HttpHeaders.IF_MATCH,scheduled.getResponse().getHeader(HttpHeaders.ETAG))
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"reason\":\"Change of plans\"}"))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(cancelled).path("data").path("status").asText()).isEqualTo("CANCELLED");
        assertThat(body(cancelled).path("data").path("cancelledAt").isTextual()).isTrue();
        assertThat(meetings.existsById(UUID.fromString(id))).isTrue();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries WHERE related_entity_id=? AND notification_type='MEETING_CANCELLED'
            """,Integer.class,UUID.fromString(id))).isEqualTo(2);
        mvc.perform(post("/api/v1/meetings/"+id+"/start").principal(principal(organizer))
            .header(HttpHeaders.IF_MATCH,cancelled.getResponse().getHeader(HttpHeaders.ETAG)))
            .andExpect(status().isConflict());
    }

    @Test void cancelledDraftWithPlannedDatesDoesNotEmitCommittedCancellationEmail() throws Exception {
        MvcResult created=mvc.perform(post("/api/v1/meetings").principal(principal(organizer))
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"title\":\"Provisional only\","
                + "\"scheduledStartAt\":\"2030-06-01T09:00:00Z\","
                + "\"scheduledEndAt\":\"2030-06-01T10:00:00Z\"}"))
            .andExpect(status().isCreated()).andReturn();
        UUID id=UUID.fromString(body(created).path("data").path("id").asText());
        mvc.perform(post("/api/v1/meetings/"+id+"/cancel")
            .principal(principal(organizer))
            .header(HttpHeaders.IF_MATCH,created.getResponse().getHeader(HttpHeaders.ETAG)))
            .andExpect(status().isOk());
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries WHERE related_entity_id=?
            """,Integer.class,id)).isZero();
    }

    @Test void duplicateActiveParticipationAndIneligibleIdentityAreRejected() throws Exception {
        MvcResult created=create();
        UUID id=UUID.fromString(body(created).path("data").path("id").asText());
        String tag=created.getResponse().getHeader(HttpHeaders.ETAG);
        mvc.perform(post("/api/v1/meetings/"+id+"/participants")
            .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,tag)
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("userId",member.getId()))))
            .andExpect(status().isConflict());
        mvc.perform(post("/api/v1/meetings/"+id+"/participants")
            .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,tag)
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("userId",pending.getId()))))
            .andExpect(status().isUnprocessableEntity());
    }

}
