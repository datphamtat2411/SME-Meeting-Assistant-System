package com.sme.meetingassistant.api.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.*;
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
 * T06 cross-module acceptance from HTTP commands to committed PostgreSQL state.
 * Deliberately NOT @Transactional so each request owns a real commit/rollback.
 * Existing tests cover smaller units and low-level PostgreSQL exclusion races.
 */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class RoomSchedulingCrossModuleAcceptanceTests {
    private static final String NINE="2030-12-16T09:00:00Z";
    private static final String TEN="2030-12-16T10:00:00Z";
    private static final String ELEVEN="2030-12-16T11:00:00Z";

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;

    UUID admin, organizer, member, outsider;

    @BeforeEach void setup() {
        admin=user("ADMINISTRATOR");
        organizer=user("EMPLOYEE");
        member=user("EMPLOYEE");
        outsider=user("EMPLOYEE");
    }

    private UUID user(String role) {
        UUID id=UUID.randomUUID();
        String email="t06-"+id+"@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'T06 Acceptance','fixture',?,'ACTIVE')
            """,id,email,email,role);
        return id;
    }
    private static Principal as(UUID id) { return ()->id.toString(); }
    private String payload(Object body) throws Exception { return json.writeValueAsString(body); }
    private JsonNode body(MvcResult r) throws Exception {
        return json.readTree(r.getResponse().getContentAsString()).path("data");
    }
    private UUID id(MvcResult r) throws Exception {
        return UUID.fromString(body(r).path("id").asText());
    }
    private String tag(MvcResult r) { return r.getResponse().getHeader(HttpHeaders.ETAG); }
    private MvcResult createRoom(int capacity) throws Exception {
        String code="AC-"+UUID.randomUUID();
        return mvc.perform(post("/api/v1/rooms").principal(as(admin))
            .contentType(MediaType.APPLICATION_JSON)
            .content(payload(Map.of("code",code,"name","Acceptance Room",
                "capacity",capacity)))).andExpect(status().isCreated()).andReturn();
    }
    private MvcResult draft(UUID owner, UUID room, String start, String end,
            List<UUID> participants) throws Exception {
        Map<String,Object> data=new LinkedHashMap<>();
        data.put("title","Cross-module acceptance");
        data.put("roomId",room);
        data.put("scheduledStartAt",start);
        data.put("scheduledEndAt",end);
        if(participants!=null)data.put("participantUserIds",participants);
        return mvc.perform(post("/api/v1/meetings").principal(as(owner))
            .contentType(MediaType.APPLICATION_JSON).content(payload(data)))
            .andExpect(status().isCreated()).andReturn();
    }
    private MvcResult command(UUID who,UUID meeting,String action,String ifMatch)
            throws Exception {
        return mvc.perform(post("/api/v1/meetings/"+meeting+"/"+action)
            .principal(as(who)).header(HttpHeaders.IF_MATCH,ifMatch))
            .andExpect(status().isOk()).andReturn();
    }
    private int count(UUID meeting,String state) {
        return jdbc.queryForObject("SELECT count(*) FROM room_reservations WHERE meeting_id=? AND status=?",
            Integer.class,meeting,state);
    }
    private int email(UUID meeting,String type) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries
            WHERE related_entity_id=? AND notification_type=?
            """,Integer.class,meeting,type);
    }
    private JsonNode roomAvailability(UUID who, UUID room, String start, String end)
            throws Exception {
        // Room stable ID is not the independently generated unique room code.
        // Query the canonical resource before selecting an availability row.
        MvcResult detail=mvc.perform(get("/api/v1/rooms/"+room).principal(as(who)))
            .andExpect(status().isOk()).andReturn();
        String code=body(detail).path("code").asText();
        MvcResult r=mvc.perform(get("/api/v1/rooms/availability").principal(as(who))
            .param("start",start).param("end",end).param("q",code))
            .andExpect(status().isOk()).andReturn();
        JsonNode rooms=body(r);
        assertThat(rooms).hasSize(1);
        return rooms.get(0);
    }
    private MvcResult check(UUID who, Map<String,Object> p) throws Exception {
        return mvc.perform(post("/api/v1/meeting-schedule-checks").principal(as(who))
            .contentType(MediaType.APPLICATION_JSON).content(payload(p)))
            .andExpect(status().isOk()).andReturn();
    }
    private Map<String,Object> proposed(UUID room,String from,String until) {
        Map<String,Object> p=new LinkedHashMap<>();
        p.put("roomId",room);
        p.put("start",from);p.put("end",until);
        return p;
    }

    @Test void completeCatalogToCancellationToHistoricalDeactivationWorkflow() throws Exception {
        MvcResult firstRoom=createRoom(1),secondRoom=createRoom(10);
        UUID roomA=id(firstRoom),roomB=id(secondRoom);

        // Catalog management remains ADMIN-only.
        mvc.perform(patch("/api/v1/rooms/"+roomA).principal(as(organizer))
            .header(HttpHeaders.IF_MATCH,tag(firstRoom))
            .contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"Forbidden\"}"))
            .andExpect(status().isForbidden());

        MvcResult draft=draft(organizer,roomA,NINE,TEN,List.of(member));
        UUID mid=id(draft);
        assertThat(count(mid,"ACTIVE")).isZero();
        mvc.perform(get("/api/v1/meetings/"+mid).principal(as(member)))
            .andExpect(status().isOk());
        mvc.perform(get("/api/v1/meetings/"+mid).principal(as(outsider)))
            .andExpect(status().isNotFound());

        Map<String,Object> preview=proposed(roomA,NINE,TEN);
        preview.put("participantUserIds",List.of(member));
        JsonNode capacityPreview=body(check(organizer,preview));
        assertThat(capacityPreview.path("canSchedule").asBoolean()).isTrue();
        assertThat(capacityPreview.path("warnings").toString())
            .contains("CAPACITY_ADVISORY_EXCEEDED");

        MvcResult booked=command(organizer,mid,"schedule",tag(draft));
        assertThat(count(mid,"ACTIVE")).isEqualTo(1);
        assertThat(email(mid,"MEETING_SCHEDULED")).isEqualTo(2);
        assertThat(roomAvailability(member,roomA,NINE,TEN).path("available").asBoolean())
            .isFalse();

        MvcResult moved=mvc.perform(patch("/api/v1/meetings/"+mid)
            .principal(as(organizer)).header(HttpHeaders.IF_MATCH,tag(booked))
            .contentType(MediaType.APPLICATION_JSON)
            .content(payload(Map.of("roomId",roomB,
                "scheduledStartAt",TEN,"scheduledEndAt",ELEVEN))))
            .andExpect(status().isOk()).andReturn();
        assertThat(count(mid,"ACTIVE")).isEqualTo(1);
        assertThat(count(mid,"RELEASED")).isEqualTo(1);
        assertThat(email(mid,"MEETING_RESCHEDULED")).isEqualTo(2);
        assertThat(roomAvailability(member,roomA,NINE,TEN).path("available").asBoolean())
            .isTrue();
        assertThat(roomAvailability(member,roomB,TEN,ELEVEN).path("available").asBoolean())
            .isFalse();

        mvc.perform(post("/api/v1/rooms/"+roomB+"/deactivate").principal(as(admin))
            .header(HttpHeaders.IF_MATCH,tag(secondRoom)))
            .andExpect(status().isConflict());

        MvcResult cancelled=command(organizer,mid,"cancel",tag(moved));
        assertThat(body(cancelled).path("status").asText()).isEqualTo("CANCELLED");
        assertThat(count(mid,"ACTIVE")).isZero();
        assertThat(count(mid,"RELEASED")).isEqualTo(2);
        assertThat(email(mid,"MEETING_CANCELLED")).isEqualTo(2);
        assertThat(roomAvailability(member,roomB,TEN,ELEVEN).path("available").asBoolean())
            .isTrue();

        mvc.perform(post("/api/v1/rooms/"+roomB+"/deactivate")
            .principal(as(admin)).header(HttpHeaders.IF_MATCH,tag(secondRoom)))
            .andExpect(status().isOk());
        assertThat(jdbc.queryForObject("SELECT status FROM rooms WHERE id=?",
            String.class,roomB)).isEqualTo("INACTIVE");
        assertThat(jdbc.queryForObject("SELECT room_id FROM meetings WHERE id=?",
            UUID.class,mid)).isEqualTo(roomB);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_participants WHERE meeting_id=? AND removed_at IS NULL
            """,Integer.class,mid)).isEqualTo(2);
    }

    @Test void stalePreviewCannotBypassCommittedCollisionOrCreateGhostEmail() throws Exception {
        UUID room=id(createRoom(8));
        MvcResult first=draft(organizer,room,NINE,TEN,null);
        MvcResult second=draft(outsider,room,NINE,TEN,null);
        assertThat(body(check(outsider,proposed(room,NINE,TEN)))
            .path("canSchedule").asBoolean()).isTrue();
        command(organizer,id(first),"schedule",tag(first));
        assertThat(body(check(outsider,proposed(room,NINE,TEN)))
            .path("canSchedule").asBoolean()).isFalse();
        mvc.perform(post("/api/v1/meetings/"+id(second)+"/schedule")
            .principal(as(outsider)).header(HttpHeaders.IF_MATCH,tag(second)))
            .andExpect(status().isConflict());
        assertThat(jdbc.queryForObject("SELECT status FROM meetings WHERE id=?",
            String.class,id(second))).isEqualTo("DRAFT");
        assertThat(count(id(second),"ACTIVE")).isZero();
        assertThat(email(id(second),"MEETING_SCHEDULED")).isZero();

        MvcResult booked=mvc.perform(get("/api/v1/meetings/"+id(first))
            .principal(as(organizer))).andExpect(status().isOk()).andReturn();
        mvc.perform(patch("/api/v1/meetings/"+id(first))
            .principal(as(organizer)).header(HttpHeaders.IF_MATCH,tag(first))
            .contentType(MediaType.APPLICATION_JSON).content("{\"roomId\":null}"))
            .andExpect(status().isPreconditionFailed());
        assertThat(tag(booked)).isNotEqualTo(tag(first));
    }

    @Test void terminalAndInProgressMeetingsCannotProduceFalsePositiveSchedulePreview()
            throws Exception {
        MvcResult initial=draft(organizer,null,NINE,TEN,null);
        UUID mid=id(initial);
        MvcResult scheduled=command(organizer,mid,"schedule",tag(initial));
        Map<String,Object> input=proposed(null,NINE,TEN);
        input.put("meetingId",mid);
        assertThat(body(check(organizer,input))
            .path("canSchedule").asBoolean()).isTrue();

        MvcResult started=command(organizer,mid,"start",tag(scheduled));
        mvc.perform(post("/api/v1/meeting-schedule-checks").principal(as(organizer))
            .contentType(MediaType.APPLICATION_JSON).content(payload(input)))
            .andExpect(status().isConflict());
        MvcResult ended=command(organizer,mid,"end",tag(started));
        assertThat(body(ended).path("status").asText()).isEqualTo("ENDED");
        mvc.perform(post("/api/v1/meeting-schedule-checks").principal(as(organizer))
            .contentType(MediaType.APPLICATION_JSON).content(payload(input)))
            .andExpect(status().isConflict());

        MvcResult draft2=draft(organizer,null,NINE,TEN,null);
        UUID otherMid=id(draft2);
        command(organizer,otherMid,"cancel",tag(draft2));
        input.put("meetingId",otherMid);
        mvc.perform(post("/api/v1/meeting-schedule-checks").principal(as(organizer))
            .contentType(MediaType.APPLICATION_JSON).content(payload(input)))
            .andExpect(status().isConflict());
    }

    @Test void participantRemovalAndAccountRevocationPreserveHistoryWithoutOldAccess()
            throws Exception {
        MvcResult initial=draft(organizer,null,NINE,TEN,List.of(member));
        UUID mid=id(initial);
        mvc.perform(get("/api/v1/meetings/"+mid).principal(as(member)))
            .andExpect(status().isOk());
        mvc.perform(delete("/api/v1/meetings/"+mid+"/participants/"+member)
            .principal(as(organizer)).header(HttpHeaders.IF_MATCH,tag(initial)))
            .andExpect(status().isOk());
        mvc.perform(get("/api/v1/meetings/"+mid).principal(as(member)))
            .andExpect(status().isNotFound());
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_participants WHERE meeting_id=? AND user_id=?
                AND removed_at IS NOT NULL
            """,Integer.class,mid,member)).isEqualTo(1);

        jdbc.update("UPDATE users SET account_status='INACTIVE' WHERE id=?",organizer);
        mvc.perform(get("/api/v1/meetings/"+mid).principal(as(organizer)))
            .andExpect(status().isUnauthorized());
        mvc.perform(post("/api/v1/meeting-schedule-checks").principal(as(organizer))
            .contentType(MediaType.APPLICATION_JSON)
            .content(payload(proposed(null,NINE,TEN))))
            .andExpect(status().isUnauthorized());
        assertThat(jdbc.queryForObject("SELECT organizer_user_id FROM meetings WHERE id=?",
            UUID.class,mid)).isEqualTo(organizer);
    }

    @Test @Timeout(45)
    void concurrentBookingAndRoomDeactivationCannotBothCommit() throws Exception {
        MvcResult roomCreated=createRoom(12);
        UUID room=id(roomCreated);
        MvcResult planned=draft(organizer,room,NINE,TEN,null);
        UUID mid=id(planned);
        var ready=new CountDownLatch(2);
        var go=new CountDownLatch(1);
        ExecutorService pool=Executors.newFixedThreadPool(2);
        try {
            Future<Integer> booking=pool.submit(()->{
                ready.countDown();
                if(!go.await(10,TimeUnit.SECONDS))throw new AssertionError("gate");
                return mvc.perform(post("/api/v1/meetings/"+mid+"/schedule")
                    .principal(as(organizer)).header(HttpHeaders.IF_MATCH,tag(planned)))
                    .andReturn().getResponse().getStatus();
            });
            Future<Integer> deactivation=pool.submit(()->{
                ready.countDown();
                if(!go.await(10,TimeUnit.SECONDS))throw new AssertionError("gate");
                return mvc.perform(post("/api/v1/rooms/"+room+"/deactivate")
                    .principal(as(admin)).header(HttpHeaders.IF_MATCH,tag(roomCreated)))
                    .andReturn().getResponse().getStatus();
            });
            assertThat(ready.await(10,TimeUnit.SECONDS)).isTrue();
            go.countDown();
            assertThat(List.of(booking.get(30,TimeUnit.SECONDS),
                deactivation.get(30,TimeUnit.SECONDS))).containsExactlyInAnyOrder(200,409);
            String status=jdbc.queryForObject("SELECT status FROM rooms WHERE id=?",
                String.class,room);
            if("INACTIVE".equals(status)) {
                assertThat(count(mid,"ACTIVE")).isZero();
                assertThat(email(mid,"MEETING_SCHEDULED")).isZero();
            } else {
                assertThat(status).isEqualTo("ACTIVE");
                assertThat(count(mid,"ACTIVE")).isEqualTo(1);
            }
        } finally {
            go.countDown();
            pool.shutdownNow();
        }
    }

    @Test void canonicalMigrationChainAndConstraintsRemainSingleSourceOfTruth() {
        assertThat(jdbc.queryForList("""
            SELECT version FROM flyway_schema_history
            WHERE success AND version IS NOT NULL ORDER BY installed_rank
            """,String.class)).startsWith("1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22");
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM pg_constraint
            WHERE conrelid='public.room_reservations'::regclass
                AND conname='ex_room_reservations_active_overlap'
            """,Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM pg_indexes
            WHERE tablename='room_reservations'
                AND indexname='ux_room_reservations_active_meeting'
            """,Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM information_schema.tables
            WHERE table_schema='public' AND table_name IN ('user_accounts','organizations')
            """,Integer.class)).isZero();
    }
}
