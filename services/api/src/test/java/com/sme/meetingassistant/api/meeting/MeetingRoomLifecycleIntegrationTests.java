package com.sme.meetingassistant.api.meeting;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.*;
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
 * T04 full HTTP -> Meeting -> Room -> PostgreSQL transaction tests. Intentionally
 * NOT @Transactional: each MockMvc request commits or rolls back independently.
 */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class MeetingRoomLifecycleIntegrationTests {
    private static final String NINE = "2030-09-10T09:00:00Z";
    private static final String TEN = "2030-09-10T10:00:00Z";
    private static final String ELEVEN = "2030-09-10T11:00:00Z";
    private static final String TWELVE = "2030-09-10T12:00:00Z";

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;

    private UUID organizer, other, administrator, roomA, roomB;

    @BeforeEach void fixtures() {
        organizer = insertUser("EMPLOYEE");
        other = insertUser("EMPLOYEE");
        administrator = insertUser("ADMINISTRATOR");
        roomA = insertRoom(); roomB = insertRoom();
    }

    private UUID insertUser(String role) {
        UUID id=UUID.randomUUID();
        String email="t04-"+id+"@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'T04 fixture','test-only',?,'ACTIVE')
            """,id,email,email,role);
        return id;
    }

    private UUID insertRoom() {
        UUID id=UUID.randomUUID();
        jdbc.update("INSERT INTO rooms(id,code,name) VALUES (?,?,?)",
            id,"R-"+id,"T04 Room "+id);
        return id;
    }
    private static Principal principal(UUID id) { return () -> id.toString(); }
    private JsonNode body(MvcResult r) throws Exception {
        return json.readTree(r.getResponse().getContentAsString());
    }

    private MvcResult draft(UUID owner, UUID room, String start, String end) throws Exception {
        String data=json.writeValueAsString(new java.util.LinkedHashMap<String,Object>() {{
            put("title","Reservation integration"); put("roomId",room);
            put("scheduledStartAt",start); put("scheduledEndAt",end);
        }});
        return mvc.perform(post("/api/v1/meetings").principal(principal(owner))
            .contentType(MediaType.APPLICATION_JSON).content(data))
            .andExpect(status().isCreated()).andReturn();
    }

    private UUID id(MvcResult r) throws Exception {
        return UUID.fromString(body(r).path("data").path("id").asText());
    }
    private String etag(MvcResult r) { return r.getResponse().getHeader(HttpHeaders.ETAG); }
    private String tag(UUID meeting, UUID actor) throws Exception {
        return etag(mvc.perform(get("/api/v1/meetings/"+meeting).principal(principal(actor)))
            .andExpect(status().isOk()).andReturn());
    }

    private MvcResult schedule(UUID actor, UUID meeting, String version) throws Exception {
        return mvc.perform(post("/api/v1/meetings/"+meeting+"/schedule")
            .principal(principal(actor)).header(HttpHeaders.IF_MATCH,version))
            .andExpect(status().isOk()).andReturn();
    }
    private int reservations(UUID meeting, String state) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM room_reservations WHERE meeting_id=? AND status=?
            """,Integer.class,meeting,state);
    }
    private int email(UUID meeting, String type) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries WHERE related_entity_id=? AND notification_type=?
            """,Integer.class,meeting,type);
    }
    private MvcResult patch(UUID actor,UUID meeting,String version,Map<String,Object> changes)
            throws Exception {
        return mvc.perform(patch("/api/v1/meetings/"+meeting).principal(principal(actor))
            .header(HttpHeaders.IF_MATCH,version).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(changes))).andExpect(status().isOk()).andReturn();
    }

    @Test void scheduleWithRoomCommitsOneReservationAndNotificationInSameTransaction() throws Exception {
        MvcResult draft=draft(organizer,roomA,NINE,TEN);
        UUID id=id(draft);
        assertThat(reservations(id,"ACTIVE")).isZero();
        MvcResult booked=schedule(organizer,id,etag(draft));
        assertThat(body(booked).path("data").path("status").asText()).isEqualTo("SCHEDULED");
        assertThat(body(booked).path("data").path("roomId").asText()).isEqualTo(roomA.toString());
        assertThat(reservations(id,"ACTIVE")).isEqualTo(1);
        assertThat(email(id,"MEETING_SCHEDULED")).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT room_id FROM room_reservations WHERE meeting_id=? AND status='ACTIVE'
            """,UUID.class,id)).isEqualTo(roomA);
    }

    @Test void competingMeetingCannotScheduleOverlappingRoomAndDraftRemainsUnchanged() throws Exception {
        MvcResult first=draft(organizer,roomA,NINE,TEN);
        MvcResult second=draft(other,roomA,NINE,TEN);
        schedule(organizer,id(first),etag(first));
        mvc.perform(post("/api/v1/meetings/"+id(second)+"/schedule")
            .principal(principal(other)).header(HttpHeaders.IF_MATCH,etag(second)))
            .andExpect(status().isConflict());
        assertThat(jdbc.queryForObject("SELECT status FROM meetings WHERE id=?",
            String.class,id(second))).isEqualTo("DRAFT");
        assertThat(reservations(id(second),"ACTIVE")).isZero();
        assertThat(email(id(second),"MEETING_SCHEDULED")).isZero();
    }

    @Test void rescheduleTimeAndRoomRetainsHistoricalReservationAndEmitsOneChange() throws Exception {
        MvcResult draft=draft(organizer,roomA,NINE,TEN);
        UUID id=id(draft);
        MvcResult booked=schedule(organizer,id,etag(draft));
        MvcResult changed=patch(organizer,id,etag(booked),Map.of(
            "roomId",roomB,"scheduledStartAt",TEN,"scheduledEndAt",ELEVEN));
        assertThat(body(changed).path("data").path("roomId").asText()).isEqualTo(roomB.toString());
        assertThat(reservations(id,"ACTIVE")).isEqualTo(1);
        assertThat(reservations(id,"RELEASED")).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT room_id FROM room_reservations WHERE meeting_id=? AND status='ACTIVE'
            """,UUID.class,id)).isEqualTo(roomB);
        assertThat(email(id,"MEETING_RESCHEDULED")).isEqualTo(1);
        assertThat(email(id,"MEETING_SCHEDULED")).isEqualTo(1);
    }

    @Test void conflictOnRescheduleRollsBackMeetingReservationAndNotificationTogether() throws Exception {
        MvcResult first=draft(organizer,roomA,NINE,TEN);
        MvcResult second=draft(other,roomB,NINE,TEN);
        MvcResult original=schedule(organizer,id(first),etag(first));
        schedule(other,id(second),etag(second));

        mvc.perform(patch("/api/v1/meetings/"+id(first))
            .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,etag(original))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("roomId",roomB,"title","must not persist"))))
            .andExpect(status().isConflict());
        JsonNode after=body(mvc.perform(get("/api/v1/meetings/"+id(first))
            .principal(principal(organizer))).andExpect(status().isOk()).andReturn()).path("data");
        assertThat(after.path("title").asText()).isEqualTo("Reservation integration");
        assertThat(after.path("roomId").asText()).isEqualTo(roomA.toString());
        assertThat(reservations(id(first),"ACTIVE")).isEqualTo(1);
        assertThat(reservations(id(first),"RELEASED")).isZero();
        assertThat(email(id(first),"MEETING_RESCHEDULED")).isZero();
    }

    @Test void roomlessTransitionReleasesOldBookingAndLaterCanBookAnotherRoom() throws Exception {
        MvcResult created=draft(organizer,roomA,NINE,TEN);
        UUID id=id(created);
        MvcResult scheduled=schedule(organizer,id,etag(created));
        MvcResult roomless=mvc.perform(patch("/api/v1/meetings/"+id)
            .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,etag(scheduled))
            .contentType(MediaType.APPLICATION_JSON).content("{\"roomId\":null}"))
            .andExpect(status().isOk()).andReturn();
        assertThat(reservations(id,"ACTIVE")).isZero();
        assertThat(reservations(id,"RELEASED")).isEqualTo(1);
        MvcResult rebooked=patch(organizer,id,etag(roomless),Map.of("roomId",roomB));
        assertThat(body(rebooked).path("data").path("status").asText()).isEqualTo("SCHEDULED");
        assertThat(reservations(id,"ACTIVE")).isEqualTo(1);
        assertThat(reservations(id,"RELEASED")).isEqualTo(1);
        assertThat(email(id,"MEETING_RESCHEDULED")).isEqualTo(2);
    }

    @Test void cancellationReleasesRoomAllowsReuseAndDoesNotDeleteMeeting() throws Exception {
        MvcResult draft=draft(organizer,roomA,NINE,TEN);
        UUID id=id(draft);
        MvcResult scheduled=schedule(organizer,id,etag(draft));
        MvcResult cancelled=mvc.perform(post("/api/v1/meetings/"+id+"/cancel")
            .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,etag(scheduled))
            .contentType(MediaType.APPLICATION_JSON).content("{\"reason\":\"Replaced\"}"))
            .andExpect(status().isOk()).andReturn();
        assertThat(body(cancelled).path("data").path("status").asText()).isEqualTo("CANCELLED");
        assertThat(reservations(id,"ACTIVE")).isZero();
        assertThat(reservations(id,"RELEASED")).isEqualTo(1);
        assertThat(email(id,"MEETING_CANCELLED")).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM meetings WHERE id=?",
            Integer.class,id)).isEqualTo(1);
        MvcResult otherDraft=draft(other,roomA,NINE,TEN);
        schedule(other,id(otherDraft),etag(otherDraft));
        assertThat(reservations(id(otherDraft),"ACTIVE")).isEqualTo(1);
    }

    @Test void roomDeactivationRejectsFutureCommitmentThenAllowsAfterCancel() throws Exception {
        MvcResult draft=draft(organizer,roomA,NINE,TEN);
        UUID id=id(draft);
        MvcResult scheduled=schedule(organizer,id,etag(draft));
        MvcResult room=mvc.perform(get("/api/v1/rooms/"+roomA)
            .principal(principal(administrator))).andExpect(status().isOk()).andReturn();
        mvc.perform(post("/api/v1/rooms/"+roomA+"/deactivate")
            .principal(principal(administrator)).header(HttpHeaders.IF_MATCH,etag(room)))
            .andExpect(status().isConflict());
        assertThat(jdbc.queryForObject("SELECT status FROM rooms WHERE id=?",
            String.class,roomA)).isEqualTo("ACTIVE");
        mvc.perform(post("/api/v1/meetings/"+id+"/cancel")
            .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,etag(scheduled)))
            .andExpect(status().isOk());
        mvc.perform(post("/api/v1/rooms/"+roomA+"/deactivate")
            .principal(principal(administrator)).header(HttpHeaders.IF_MATCH,etag(room)))
            .andExpect(status().isOk());
        // Newly created drafts may not provisionally select a deactivated room.
        mvc.perform(post("/api/v1/meetings").principal(principal(other))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of(
                "title","Inactive room", "roomId",roomA,
                "scheduledStartAt",TEN,"scheduledEndAt",ELEVEN))))
            .andExpect(status().isUnprocessableEntity());
    }

    @Test void unchangedScheduledTimesOrMetadataDoNotCreateReservationChurnOrMail() throws Exception {
        MvcResult original=draft(organizer,roomA,NINE,TEN);
        UUID id=id(original);
        MvcResult scheduled=schedule(organizer,id,etag(original));
        MvcResult updated=patch(organizer,id,etag(scheduled),Map.of(
            "title","Metadata only","scheduledStartAt","2030-09-10T16:00:00+07:00"));
        assertThat(body(updated).path("data").path("title").asText()).isEqualTo("Metadata only");
        assertThat(reservations(id,"ACTIVE")).isEqualTo(1);
        assertThat(reservations(id,"RELEASED")).isZero();
        assertThat(email(id,"MEETING_RESCHEDULED")).isZero();
    }

    @Test void wrongActorAndStaleEtagCannotMutateCommittedSchedule() throws Exception {
        MvcResult original=draft(organizer,roomA,NINE,TEN);
        UUID id=id(original);
        MvcResult booked=schedule(organizer,id,etag(original));
        mvc.perform(patch("/api/v1/meetings/"+id)
            .principal(principal(other)).header(HttpHeaders.IF_MATCH,etag(booked))
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"scheduledStartAt\":\"2030-09-10T11:00:00Z\"}"))
            .andExpect(status().isNotFound());
        mvc.perform(patch("/api/v1/meetings/"+id)
            .principal(principal(administrator)).header(HttpHeaders.IF_MATCH,etag(booked))
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"roomId\":null}"))
            .andExpect(status().isNotFound());
        mvc.perform(patch("/api/v1/meetings/"+id)
            .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,etag(original))
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"roomId\":null}"))
            .andExpect(status().isPreconditionFailed());
        assertThat(reservations(id,"ACTIVE")).isEqualTo(1);
    }

    @Test void adjacentMeetingIntervalsStillAllowed() throws Exception {
        MvcResult one=draft(organizer,roomA,NINE,TEN);
        MvcResult two=draft(other,roomA,TEN,ELEVEN);
        schedule(organizer,id(one),etag(one));
        schedule(other,id(two),etag(two));
        assertThat(reservations(id(one),"ACTIVE")).isEqualTo(1);
        assertThat(reservations(id(two),"ACTIVE")).isEqualTo(1);
    }

    @Test @Timeout(45)
    void realConcurrentHttpScheduleOnlyOneOverlappingBookingCommits() throws Exception {
        MvcResult first=draft(organizer,roomA,NINE,TEN);
        MvcResult second=draft(other,roomA,NINE,TEN);
        UUID a=id(first), b=id(second);
        String ta=etag(first),tb=etag(second);
        var gate=new CountDownLatch(1);
        var ready=new CountDownLatch(2);
        ExecutorService pool=Executors.newFixedThreadPool(2);
        try {
            Callable<Integer> attemptA=()->{
                ready.countDown(); if(!gate.await(10,TimeUnit.SECONDS)) throw new AssertionError("gate");
                return mvc.perform(post("/api/v1/meetings/"+a+"/schedule")
                    .principal(principal(organizer)).header(HttpHeaders.IF_MATCH,ta))
                    .andReturn().getResponse().getStatus();
            };
            Callable<Integer> attemptB=()->{
                ready.countDown(); if(!gate.await(10,TimeUnit.SECONDS)) throw new AssertionError("gate");
                return mvc.perform(post("/api/v1/meetings/"+b+"/schedule")
                    .principal(principal(other)).header(HttpHeaders.IF_MATCH,tb))
                    .andReturn().getResponse().getStatus();
            };
            Future<Integer> fa=pool.submit(attemptA),fb=pool.submit(attemptB);
            assertThat(ready.await(10,TimeUnit.SECONDS)).isTrue();
            gate.countDown();
            assertThat(java.util.List.of(fa.get(30,TimeUnit.SECONDS),
                fb.get(30,TimeUnit.SECONDS))).containsExactlyInAnyOrder(200,409);
            assertThat(reservations(a,"ACTIVE")+reservations(b,"ACTIVE")).isEqualTo(1);
            assertThat(email(a,"MEETING_SCHEDULED")+email(b,"MEETING_SCHEDULED")).isEqualTo(1);
        } finally {
            gate.countDown();
            pool.shutdownNow();
        }
    }
}
