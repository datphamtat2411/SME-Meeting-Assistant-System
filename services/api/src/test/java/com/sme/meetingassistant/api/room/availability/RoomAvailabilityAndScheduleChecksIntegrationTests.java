package com.sme.meetingassistant.api.room.availability;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.*;
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
 * Real committed PostgreSQL transactions through the canonical HTTP API.
 * Read-only previews never take the place of the commit-time GiST guard.
 */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class RoomAvailabilityAndScheduleChecksIntegrationTests {
    private static final String NINE="2030-09-11T09:00:00Z";
    private static final String TEN="2030-09-11T10:00:00Z";
    private static final String ELEVEN="2030-09-11T11:00:00Z";
    private UUID actor,other,member,roomA,roomB;
    private String fixturePrefix;

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;

    @BeforeEach void setup() {
        fixturePrefix=UUID.randomUUID().toString().substring(0,8);
        actor=user(); other=user(); member=user();
        roomA=room(1);roomB=room(10);
    }
    private UUID user() {
        UUID id=UUID.randomUUID();
        String email="t05-"+id+"@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Availability fixture','fixture','EMPLOYEE','ACTIVE')
            """,id,email,email);
        return id;
    }
    private UUID room(Integer capacity) {
        UUID id=UUID.randomUUID();
        jdbc.update("INSERT INTO rooms(id,code,name,capacity) VALUES (?,?,?,?)",
            id,"AV-"+fixturePrefix+"-"+id,"Available Room "+id,capacity);
        return id;
    }
    private static Principal principal(UUID id) { return ()->id.toString(); }
    private JsonNode data(MvcResult response) throws Exception {
        return json.readTree(response.getResponse().getContentAsString()).path("data");
    }
    private MvcResult draft(UUID owner,UUID room, String start,String end,List<UUID> participants)
            throws Exception {
        Map<String,Object> body=new LinkedHashMap<>();
        body.put("title","Availability preview fixture");
        body.put("roomId",room);body.put("scheduledStartAt",start);body.put("scheduledEndAt",end);
        if(participants!=null)body.put("participantUserIds",participants);
        return mvc.perform(post("/api/v1/meetings")
            .principal(principal(owner)).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(body))).andExpect(status().isCreated()).andReturn();
    }
    private UUID meetingId(MvcResult result) throws Exception {
        return UUID.fromString(data(result).path("id").asText());
    }
    private String etag(MvcResult result) {return result.getResponse().getHeader(HttpHeaders.ETAG);}
    private MvcResult schedule(UUID owner,MvcResult draft) throws Exception {
        return mvc.perform(post("/api/v1/meetings/"+meetingId(draft)+"/schedule")
            .principal(principal(owner)).header(HttpHeaders.IF_MATCH,etag(draft)))
            .andExpect(status().isOk()).andReturn();
    }
    private MvcResult availability(UUID who,String start,String end) throws Exception {
        return mvc.perform(get("/api/v1/rooms/availability").principal(principal(who))
            .param("start",start).param("end",end).param("q",fixturePrefix))
            .andExpect(status().isOk()).andReturn();
    }
    private JsonNode find(JsonNode values,UUID id) {
        for(JsonNode item:values) if(id.toString().equals(item.path("id").asText()))return item;
        throw new AssertionError("Room missing in availability result: "+id);
    }
    private MvcResult check(UUID who,Map<String,Object> payload) throws Exception {
        return mvc.perform(post("/api/v1/meeting-schedule-checks")
            .principal(principal(who)).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(payload))).andExpect(status().isOk()).andReturn();
    }
    private Map<String,Object> proposal(UUID room,String start,String end) {
        Map<String,Object> payload=new HashMap<>();
        payload.put("roomId",room);payload.put("start",start);payload.put("end",end);
        return payload;
    }

    @Test void activeRoomsAppearAndDraftDoesNotBlockAvailableRooms() throws Exception {
        draft(actor,roomA,NINE,TEN,null);
        JsonNode rooms=data(availability(actor,NINE,TEN));
        assertThat(find(rooms,roomA).path("available").asBoolean()).isTrue();
        assertThat(find(rooms,roomB).path("available").asBoolean()).isTrue();
        assertThat(find(rooms,roomA).path("capacity").asInt()).isEqualTo(1);
    }

    @Test void committedOverlapBlocksButAdjacentSlotRemainsFreeAndOtherRoomsIndependent() throws Exception {
        MvcResult draft=draft(actor,roomA,NINE,TEN,null);
        schedule(actor,draft);
        JsonNode during=data(availability(other,NINE,TEN));
        assertThat(find(during,roomA).path("available").asBoolean()).isFalse();
        assertThat(find(during,roomB).path("available").asBoolean()).isTrue();
        JsonNode adjacent=data(availability(other,TEN,ELEVEN));
        assertThat(find(adjacent,roomA).path("available").asBoolean()).isTrue();
        JsonNode otherZone=data(availability(other,
            "2030-09-11T16:00:00+07:00","2030-09-11T17:00:00+07:00"));
        assertThat(find(otherZone,roomA).path("available").asBoolean()).isFalse();
    }

    @Test void onlyActiveReservationsContributeAfterCancellationOrEnd() throws Exception {
        MvcResult draft=draft(actor,roomA,NINE,TEN,null);
        MvcResult scheduled=schedule(actor,draft);
        mvc.perform(post("/api/v1/meetings/"+meetingId(draft)+"/cancel")
            .principal(principal(actor)).header(HttpHeaders.IF_MATCH,etag(scheduled)))
            .andExpect(status().isOk());
        assertThat(find(data(availability(actor,NINE,TEN)),roomA)
            .path("available").asBoolean()).isTrue();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM room_reservations WHERE meeting_id=? AND status='RELEASED'
            """,Integer.class,meetingId(draft))).isEqualTo(1);
    }

    @Test void activeOnlyCapacityAndSearchFiltersApplyBeforePagination() throws Exception {
        UUID inactive=room(30);
        jdbc.update("UPDATE rooms SET status='INACTIVE' WHERE id=?",inactive);
        MvcResult booked=schedule(actor,draft(actor,roomA,NINE,TEN,null));
        MvcResult result=mvc.perform(get("/api/v1/rooms/availability")
            .principal(principal(other)).param("start",NINE).param("end",TEN)
            .param("q",roomB.toString()).param("minCapacity","5")
            .param("availableOnly","true").param("participantCount","11")
            .param("page","0").param("size","1")).andExpect(status().isOk()).andReturn();
        assertThat(data(result)).hasSize(1);
        JsonNode one=data(result).get(0);
        assertThat(one.path("id").asText()).isEqualTo(roomB.toString());
        assertThat(one.path("capacityExceeded").asBoolean()).isTrue();
        assertThat(json.readTree(result.getResponse().getContentAsString()).path("meta")
            .path("pagination").path("totalElements").asLong()).isEqualTo(1);
        assertThat(data(availability(actor,NINE,TEN)).toString()).doesNotContain(inactive.toString());
        assertThat(data(availability(actor,NINE,TEN)).toString()).contains(roomA.toString());
        assertThat(booked.getResponse().getStatus()).isEqualTo(200);
    }

    @Test void unknownCapacityIsNotInventedAsPolicyOrEnforced() throws Exception {
        UUID unlimited=room(null);
        MvcResult r=mvc.perform(get("/api/v1/rooms/availability")
            .principal(principal(actor)).param("start",NINE).param("end",TEN)
            .param("q",unlimited.toString()).param("participantCount","4"))
            .andExpect(status().isOk()).andReturn();
        JsonNode unknown=find(data(r),unlimited);
        assertThat(unknown.path("capacity").isNull()).isTrue();
        assertThat(unknown.path("capacityExceeded").isNull()).isTrue();
    }

    @Test void invalidIntervalAndNonPositiveFilterFailWithClientError() throws Exception {
        mvc.perform(get("/api/v1/rooms/availability").principal(principal(actor))
            .param("start",TEN).param("end",NINE))
            .andExpect(status().isUnprocessableEntity());
        mvc.perform(get("/api/v1/rooms/availability").principal(principal(actor))
            .param("start",NINE).param("end",NINE))
            .andExpect(status().isUnprocessableEntity());
        mvc.perform(get("/api/v1/rooms/availability").principal(principal(actor))
            .param("start",NINE).param("end",TEN).param("minCapacity","0"))
            .andExpect(status().isUnprocessableEntity());
        mvc.perform(post("/api/v1/meeting-schedule-checks").principal(principal(actor))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(proposal(roomA,TEN,NINE))))
            .andExpect(status().isUnprocessableEntity());
    }

    @Test void previewReportsHardRoomConflictButDoesNotMutateMeetingOrReservations() throws Exception {
        MvcResult booked=schedule(actor,draft(actor,roomA,NINE,TEN,null));
        Map<String,Object> input=proposal(roomA,NINE,TEN);
        input.put("participantUserIds",List.of(member));
        JsonNode report=data(check(other,input));
        assertThat(report.path("previewOnly").asBoolean()).isTrue();
        assertThat(report.path("roomConflict").asBoolean()).isTrue();
        assertThat(report.path("canSchedule").asBoolean()).isFalse();
        assertThat(report.path("room").path("available").asBoolean()).isFalse();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM meetings",Integer.class)).isGreaterThan(0);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM room_reservations WHERE room_id=? AND status='ACTIVE'
            """,Integer.class,roomA)).isEqualTo(1);
        assertThat(booked.getResponse().getStatus()).isEqualTo(200);
    }

    @Test void selfExclusionRequiresOrganizerAndAllowsOwnReschedulePreview() throws Exception {
        MvcResult draft=draft(actor,roomA,NINE,TEN,List.of(member));
        schedule(actor,draft);
        UUID id=meetingId(draft);
        Map<String,Object> own=proposal(roomA,NINE,TEN);
        own.put("meetingId",id);
        JsonNode report=data(check(actor,own));
        assertThat(report.path("canSchedule").asBoolean()).isTrue();
        assertThat(report.path("roomConflict").asBoolean()).isFalse();
        assertThat(report.path("warnings")).hasSize(0);
        mvc.perform(post("/api/v1/meeting-schedule-checks").principal(principal(other))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(own))).andExpect(status().isNotFound());
        assertThat(data(check(other,proposal(roomA,NINE,TEN)))
            .path("roomConflict").asBoolean()).isTrue();
    }

    @Test void capacityExceededIsAdvisoryAndDoesNotPretendToEnforcePolicy() throws Exception {
        Map<String,Object> params=proposal(roomA,NINE,TEN);
        params.put("participantUserIds",List.of(member));
        JsonNode signal=data(check(actor,params));
        assertThat(signal.path("canSchedule").asBoolean()).isTrue();
        assertThat(signal.path("room").path("capacityExceeded").asBoolean()).isTrue();
        assertThat(signal.path("warnings").toString()).contains("CAPACITY_ADVISORY_EXCEEDED");
        MvcResult d=draft(actor,roomA,NINE,TEN,List.of(member));
        schedule(actor,d); // No configured enforced-capacity policy.
    }

    @Test void participantWarningsAreLimitedToCallerAccessibleMeetings() throws Exception {
        MvcResult privateEvent=draft(other,roomB,NINE,TEN,List.of(member));
        schedule(other,privateEvent);
        Map<String,Object> proposal=proposal(roomA,NINE,TEN);
        proposal.put("participantUserIds",List.of(member));
        JsonNode outsider=data(check(actor,proposal));
        assertThat(outsider.path("warnings").toString()).doesNotContain("PARTICIPANT_OVERLAP");
        assertThat(outsider.path("canSchedule").asBoolean()).isTrue();

        MvcResult visibleEvent=draft(actor,null,NINE,TEN,List.of(member));
        schedule(actor,visibleEvent);
        JsonNode visible=data(check(actor,proposal));
        assertThat(visible.path("warnings").toString()).contains("PARTICIPANT_OVERLAP");
        assertThat(visible.path("roomConflict").asBoolean()).isFalse();
        assertThat(visible.path("canSchedule").asBoolean()).isTrue();
        assertThat(visible.path("warnings").toString()).doesNotContain(privateEvent.toString());
    }

    @Test void previewCanBecomeStaleButAuthoritativeCommitStillRejectsConflict() throws Exception {
        MvcResult first=draft(actor,roomA,NINE,TEN,null);
        MvcResult second=draft(other,roomA,NINE,TEN,null);
        assertThat(data(check(other,proposal(roomA,NINE,TEN)))
            .path("canSchedule").asBoolean()).isTrue();
        schedule(actor,first);
        mvc.perform(post("/api/v1/meetings/"+meetingId(second)+"/schedule")
            .principal(principal(other)).header(HttpHeaders.IF_MATCH,etag(second)))
            .andExpect(status().isConflict());
        assertThat(data(check(other,proposal(roomA,NINE,TEN)))
            .path("canSchedule").asBoolean()).isFalse();
    }

    @Test void anonymousOrInactiveCallerCannotReadRoomAvailabilityOrChecks() throws Exception {
        mvc.perform(get("/api/v1/rooms/availability").param("start",NINE).param("end",TEN))
            .andExpect(status().isUnauthorized());
        mvc.perform(post("/api/v1/meeting-schedule-checks")
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(
                proposal(roomA,NINE,TEN)))).andExpect(status().isUnauthorized());
        jdbc.update("UPDATE users SET account_status='INACTIVE' WHERE id=?",other);
        mvc.perform(get("/api/v1/rooms/availability").principal(principal(other))
            .param("start",NINE).param("end",TEN)).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/v1/meeting-schedule-checks").principal(principal(other))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(proposal(roomA,NINE,TEN))))
            .andExpect(status().isUnauthorized());
    }
}
