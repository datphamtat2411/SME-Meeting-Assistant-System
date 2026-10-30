package com.sme.meetingassistant.api.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
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
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * T04 final cross-module acceptance of T01 audit + T02 idempotent creation +
 * T03 caller-scoped queries against canonical Meeting, Room, Membership and
 * Notification services. No surrounding test transaction: each HTTP command
 * must commit independently or roll back on failure.
 */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class FinalMeetingOperationsAcceptanceTests {
    private static final String NINE = "2031-05-14T09:00:00Z";
    private static final String TEN = "2031-05-14T10:00:00Z";
    private static final String ELEVEN = "2031-05-14T11:00:00Z";
    private static final String TWELVE = "2031-05-14T12:00:00Z";

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;

    UUID organizer, member, newcomer, outsider, admin;

    @BeforeEach void fixture() {
        organizer=user("EMPLOYEE");
        member=user("EMPLOYEE");
        newcomer=user("EMPLOYEE");
        outsider=user("EMPLOYEE");
        admin=user("ADMINISTRATOR");
    }

    private UUID user(String role) {
        UUID id=UUID.randomUUID();
        String email="t04-ops-"+id+"@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Final meeting ops fixture','test-only',?,'ACTIVE')
            """, id,email,email,role);
        return id;
    }

    private UUID room() {
        UUID id=UUID.randomUUID();
        jdbc.update("INSERT INTO rooms(id,code,name) VALUES (?,?,?)",
            id,"OPS-"+id,"Ops integration room");
        return id;
    }

    private static Principal as(UUID actor) {
        return () -> actor.toString();
    }

    private MvcResult create(UUID actor,String key,Map<String,Object> data) throws Exception {
        var req=post("/api/v1/meetings").principal(as(actor))
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(data));
        if(key!=null)req.header("Idempotency-Key",key);
        return mvc.perform(req).andExpect(status().isCreated()).andReturn();
    }

    private Map<String,Object> draft(String title,UUID room,String start,String end,UUID... members) {
        Map<String,Object> data=new LinkedHashMap<>();
        data.put("title",title);
        data.put("participantUserIds",List.of(members));
        if(room!=null)data.put("roomId",room);
        if(start!=null)data.put("scheduledStartAt",start);
        if(end!=null)data.put("scheduledEndAt",end);
        return data;
    }

    private static String etag(MvcResult result) {
        return result.getResponse().getHeader(HttpHeaders.ETAG);
    }

    private JsonNode body(MvcResult r) throws Exception {
        return json.readTree(r.getResponse().getContentAsString());
    }

    private UUID id(MvcResult r) throws Exception {
        return UUID.fromString(body(r).path("data").path("id").asText());
    }

    private MvcResult postCommand(UUID who,UUID mid,String action,String ifMatch)
            throws Exception {
        return mvc.perform(post("/api/v1/meetings/"+mid+"/"+action)
            .principal(as(who)).header(HttpHeaders.IF_MATCH,ifMatch))
            .andExpect(status().isOk()).andReturn();
    }

    private MvcResult patchSchedule(UUID who,UUID mid,String ifMatch,UUID room,
            String start,String end) throws Exception {
        Map<String,Object> values=new LinkedHashMap<>();
        values.put("roomId",room);
        values.put("scheduledStartAt",start);
        values.put("scheduledEndAt",end);
        return mvc.perform(patch("/api/v1/meetings/"+mid)
            .principal(as(who)).header(HttpHeaders.IF_MATCH,ifMatch)
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(values)))
            .andExpect(status().isOk()).andReturn();
    }

    private MvcResult detail(UUID who,UUID mid) throws Exception {
        return mvc.perform(get("/api/v1/meetings/"+mid).principal(as(who)))
            .andExpect(status().isOk()).andReturn();
    }

    private MvcResult list(UUID who,String relationship) throws Exception {
        MockHttpServletRequestBuilder request=get("/api/v1/meetings")
            .principal(as(who)).param("sort","createdAt,desc");
        if(relationship!=null)request.param("relationship",relationship);
        return mvc.perform(request).andExpect(status().isOk()).andReturn();
    }

    private boolean contains(MvcResult list,UUID mid) throws Exception {
        for(JsonNode row:body(list).path("data")) {
            if(mid.toString().equals(row.path("id").asText()))return true;
        }
        return false;
    }

    private int audit(UUID mid,String action) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM audit_events WHERE meeting_id=? AND action_code=?
            """,Integer.class,mid,action);
    }

    private int bookings(UUID mid,String status) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM room_reservations WHERE meeting_id=? AND status=?
            """,Integer.class,mid,status);
    }

    private int email(UUID mid,String action,String state,UUID recipient) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries
            WHERE related_entity_type='MEETING' AND related_entity_id=?
              AND notification_type=? AND status=? AND recipient_user_id=?
            """,Integer.class,mid,action,state,recipient);
    }

    private int membershipEmail(UUID mid,String action,String state,UUID recipient) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries e
            JOIN meeting_participants p ON p.id=e.related_entity_id
            WHERE e.related_entity_type='MEETING_PARTICIPANT' AND p.meeting_id=?
              AND e.notification_type=? AND e.status=? AND e.recipient_user_id=?
            """,Integer.class,mid,action,state,recipient);
    }

    @Test void retrySafeCreateFlowsThroughAuditQueriesRoomNotificationsAndCancellation()
            throws Exception {
        UUID roomA=room(),roomB=room();
        Map<String,Object> initial=draft("Confidential milestone",roomA,NINE,TEN,member);
        MvcResult first=create(organizer,"t04-e2e-key",initial);
        UUID mid=id(first);
        MvcResult duplicate=create(organizer,"t04-e2e-key",initial);
        assertThat(id(duplicate)).isEqualTo(mid);
        assertThat(etag(duplicate)).isEqualTo(etag(first));
        assertThat(audit(mid,"MEETING_CREATED")).isEqualTo(1);
        assertThat(audit(mid,"MEETING_PARTICIPANT_ADDED")).isEqualTo(2);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_participants WHERE meeting_id=?
            """,Integer.class,mid)).isEqualTo(2);
        assertThat(bookings(mid,"ACTIVE")).isZero();
        assertThat(contains(list(organizer,"ORGANIZER"),mid)).isTrue();
        assertThat(contains(list(organizer,"PARTICIPANT"),mid)).isFalse();
        assertThat(contains(list(member,"PARTICIPANT"),mid)).isTrue();
        assertThat(contains(list(outsider,null),mid)).isFalse();
        assertThat(contains(list(admin,null),mid)).isFalse();

        MvcResult scheduled=postCommand(organizer,mid,"schedule",etag(first));
        assertThat(bookings(mid,"ACTIVE")).isEqualTo(1);
        assertThat(email(mid,"MEETING_SCHEDULED","PENDING",member)).isEqualTo(1);
        assertThat(audit(mid,"MEETING_SCHEDULED")).isEqualTo(1);

        // A lost creation response must never replay stale DRAFT metadata or
        // overwrite subsequent lifecycle mutations.
        MvcResult replayAfterSchedule=create(organizer,"t04-e2e-key",initial);
        assertThat(body(replayAfterSchedule).path("data").path("status").asText())
            .isEqualTo("SCHEDULED");
        assertThat(etag(replayAfterSchedule)).isEqualTo(etag(scheduled));
        assertThat(audit(mid,"MEETING_CREATED")).isEqualTo(1);

        mvc.perform(post("/api/v1/meetings/"+mid+"/participants")
            .principal(as(organizer)).header(HttpHeaders.IF_MATCH,etag(scheduled))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("userId",newcomer))))
            .andExpect(status().isCreated());
        assertThat(audit(mid,"MEETING_PARTICIPANT_ADDED")).isEqualTo(3);
        assertThat(membershipEmail(mid,"MEETING_PARTICIPANT_ADDED","PENDING",newcomer))
            .isEqualTo(1);

        MvcResult removed=mvc.perform(delete(
            "/api/v1/meetings/"+mid+"/participants/"+member)
            .principal(as(organizer)).header(HttpHeaders.IF_MATCH,etag(detail(organizer,mid))))
            .andExpect(status().isOk()).andReturn();
        assertThat(audit(mid,"MEETING_PARTICIPANT_REMOVED")).isEqualTo(1);
        assertThat(contains(list(member,"PARTICIPANT"),mid)).isFalse();
        assertThat(contains(list(newcomer,"PARTICIPANT"),mid)).isTrue();
        assertThat(email(mid,"MEETING_SCHEDULED","SKIPPED",member)).isEqualTo(1);
        assertThat(membershipEmail(mid,"MEETING_PARTICIPANT_REMOVED","PENDING",member))
            .isEqualTo(1);

        MvcResult moved=patchSchedule(organizer,mid,etag(removed),roomB,TEN,ELEVEN);
        assertThat(bookings(mid,"ACTIVE")).isEqualTo(1);
        assertThat(bookings(mid,"RELEASED")).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT room_id FROM room_reservations
              WHERE meeting_id=? AND status='ACTIVE'
            """,UUID.class,mid)).isEqualTo(roomB);
        assertThat(audit(mid,"MEETING_RESCHEDULED")).isEqualTo(1);
        String provenance=jdbc.queryForObject("""
            SELECT metadata::text FROM audit_events
            WHERE meeting_id=? AND action_code='MEETING_RESCHEDULED'
            """,String.class,mid);
        JsonNode details=json.readTree(provenance);
        assertThat(details.path("before").path("roomId").asText()).isEqualTo(roomA.toString());
        assertThat(details.path("after").path("roomId").asText()).isEqualTo(roomB.toString());
        assertThat(details.path("before").path("scheduledStartAt").asText()).isEqualTo(NINE);
        assertThat(details.path("after").path("scheduledStartAt").asText()).isEqualTo(TEN);
        assertThat(provenance).doesNotContain("Confidential milestone");
        assertThat(email(mid,"MEETING_RESCHEDULED","PENDING",member)).isZero();
        assertThat(email(mid,"MEETING_RESCHEDULED","PENDING",newcomer)).isEqualTo(1);

        MvcResult cancelled=postCommand(organizer,mid,"cancel",etag(moved));
        assertThat(body(cancelled).path("data").path("status").asText())
            .isEqualTo("CANCELLED");
        assertThat(bookings(mid,"ACTIVE")).isZero();
        assertThat(bookings(mid,"RELEASED")).isEqualTo(2);
        assertThat(audit(mid,"MEETING_CANCELLED")).isEqualTo(1);
        assertThat(email(mid,"MEETING_RESCHEDULED","SKIPPED",newcomer)).isEqualTo(1);
        assertThat(email(mid,"MEETING_CANCELLED","PENDING",newcomer)).isEqualTo(1);
        assertThat(email(mid,"MEETING_CANCELLED","PENDING",member)).isZero();

        MvcResult replayAfterCancel=create(organizer,"t04-e2e-key",initial);
        assertThat(id(replayAfterCancel)).isEqualTo(mid);
        assertThat(etag(replayAfterCancel)).isEqualTo(etag(cancelled));
        assertThat(body(replayAfterCancel).path("data").path("status").asText())
            .isEqualTo("CANCELLED");
        assertThat(audit(mid,"MEETING_CREATED")).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_creation_idempotency
             WHERE actor_user_id=? AND meeting_id=?
            """,Integer.class,organizer,mid)).isEqualTo(1);
    }

    @Test void reservationFailureAndConflictingRetryLeaveAllCrossModuleEffectsUnchanged()
            throws Exception {
        UUID target=room();
        Map<String,Object> a=draft("First booking",target,NINE,TEN);
        Map<String,Object> b=draft("Second booking",target,NINE,TEN,member);
        MvcResult first=create(organizer,"room-win",a);
        MvcResult second=create(outsider,"room-lose",b);
        UUID aId=id(first),bId=id(second);
        postCommand(organizer,aId,"schedule",etag(first));
        int beforeAudit=jdbc.queryForObject(
            "SELECT count(*) FROM audit_events WHERE meeting_id=?",Integer.class,bId);
        int beforeMembers=jdbc.queryForObject(
            "SELECT count(*) FROM meeting_participants WHERE meeting_id=?",Integer.class,bId);

        mvc.perform(post("/api/v1/meetings/"+bId+"/schedule")
            .principal(as(outsider)).header(HttpHeaders.IF_MATCH,etag(second)))
            .andExpect(status().isConflict());
        assertThat(bookings(bId,"ACTIVE")).isZero();
        assertThat(audit(bId,"MEETING_SCHEDULED")).isZero();
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM audit_events WHERE meeting_id=?",Integer.class,bId))
            .isEqualTo(beforeAudit);
        assertThat(email(bId,"MEETING_SCHEDULED","PENDING",member)).isZero();
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM meeting_participants WHERE meeting_id=?",Integer.class,bId))
            .isEqualTo(beforeMembers);
        assertThat(body(detail(outsider,bId)).path("data").path("status").asText())
            .isEqualTo("DRAFT");

        MvcResult conflict=mvc.perform(post("/api/v1/meetings")
            .principal(as(outsider)).header("Idempotency-Key","room-lose")
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(draft("Different intent",target,NINE,TEN,member))))
            .andExpect(status().isConflict()).andReturn();
        assertThat(conflict.getResponse().getHeader(HttpHeaders.LOCATION)).isNull();
        MvcResult replay=create(outsider,"room-lose",b);
        assertThat(id(replay)).isEqualTo(bId);
        assertThat(audit(bId,"MEETING_CREATED")).isEqualTo(1);

        // Reschedule the still-DRAFT losing meeting to an adjacent interval:
        // no phantom reservation, so commitment now succeeds normally.
        MvcResult adjusted=patchSchedule(outsider,bId,etag(replay),target,TEN,ELEVEN);
        MvcResult booked=postCommand(outsider,bId,"schedule",etag(adjusted));
        assertThat(bookings(bId,"ACTIVE")).isEqualTo(1);
        assertThat(audit(bId,"MEETING_SCHEDULED")).isEqualTo(1);
        assertThat(email(bId,"MEETING_SCHEDULED","PENDING",member)).isEqualTo(1);
        assertThat(contains(list(member,"PARTICIPANT"),bId)).isTrue();
        assertThat(contains(list(outsider,"ORGANIZER"),bId)).isTrue();
        assertThat(contains(list(organizer,"PARTICIPANT"),bId)).isFalse();
        assertThat(body(booked).path("data").path("scheduledStartAt").asText())
            .isEqualTo(TEN);
    }

    @Test void revokedMembershipAndDeniedMutationsCannotBeRecoveredByQueryOrRetry()
            throws Exception {
        MvcResult created=create(organizer,"private-create",draft(
            "Restricted meeting",null,NINE,TEN,member));
        UUID mid=id(created);
        for(UUID denied:List.of(outsider,admin,member)) {
            mvc.perform(patch("/api/v1/meetings/"+mid)
                .principal(as(denied)).header(HttpHeaders.IF_MATCH,etag(created))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"title\":\"Not permitted\"}"))
                .andExpect(status().isNotFound());
        }
        mvc.perform(post("/api/v1/meetings/"+mid+"/schedule")
            .principal(as(organizer)).header(HttpHeaders.IF_MATCH,"\"stale\""))
            .andExpect(status().isPreconditionFailed());
        assertThat(audit(mid,"MEETING_UPDATED")).isZero();
        assertThat(audit(mid,"MEETING_SCHEDULED")).isZero();

        mvc.perform(delete("/api/v1/meetings/"+mid+"/participants/"+member)
            .principal(as(organizer)).header(HttpHeaders.IF_MATCH,etag(created)))
            .andExpect(status().isOk());
        assertThat(audit(mid,"MEETING_PARTICIPANT_REMOVED")).isEqualTo(1);
        mvc.perform(get("/api/v1/meetings/"+mid).principal(as(member)))
            .andExpect(status().isNotFound());
        assertThat(contains(list(member,null),mid)).isFalse();
        assertThat(contains(list(member,"PARTICIPANT"),mid)).isFalse();
        assertThat(contains(list(organizer,"ORGANIZER"),mid)).isTrue();

        // An idempotent creation replay is scoped to the ORIGINAL organizer,
        // and cannot be used as a read capability by an unrelated user.
        MvcResult other=create(outsider,"private-create",
            draft("Own different meeting",null,NINE,TEN));
        assertThat(id(other)).isNotEqualTo(mid);
        assertThat(contains(list(outsider,"PARTICIPANT"),mid)).isFalse();
        assertThat(contains(list(admin,null),mid)).isFalse();
        assertThat(audit(mid,"MEETING_CREATED")).isEqualTo(1);
    }

    @Test @Timeout(60)
    void concurrentCreateRetryAndLaterCommitShareOneAuditAndOneNotificationIntent()
            throws Exception {
        UUID reserved=room();
        Map<String,Object> payload=draft("Concurrent cross module",reserved,TEN,ELEVEN,member);
        var pool=Executors.newFixedThreadPool(2);
        CountDownLatch ready=new CountDownLatch(2),begin=new CountDownLatch(1);
        try {
            java.util.concurrent.Callable<MvcResult> request=()->{
                ready.countDown();
                if(!begin.await(15,TimeUnit.SECONDS))
                    throw new IllegalStateException("Concurrent start timeout");
                return create(organizer,"cross-race",payload);
            };
            var one=pool.submit(request);
            var two=pool.submit(request);
            assertThat(ready.await(15,TimeUnit.SECONDS)).isTrue();
            begin.countDown();
            MvcResult a=one.get(45,TimeUnit.SECONDS),b=two.get(45,TimeUnit.SECONDS);
            UUID mid=id(a);
            assertThat(mid).isEqualTo(id(b));
            assertThat(audit(mid,"MEETING_CREATED")).isEqualTo(1);
            assertThat(audit(mid,"MEETING_PARTICIPANT_ADDED")).isEqualTo(2);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM meetings WHERE created_by_user_id=?
                  AND title='Concurrent cross module'
                """,Integer.class,organizer)).isEqualTo(1);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM meeting_participants WHERE meeting_id=?
                """,Integer.class,mid)).isEqualTo(2);
            MvcResult scheduled=postCommand(organizer,mid,"schedule",etag(a));
            assertThat(bookings(mid,"ACTIVE")).isEqualTo(1);
            assertThat(email(mid,"MEETING_SCHEDULED","PENDING",member)).isEqualTo(1);
            assertThat(audit(mid,"MEETING_SCHEDULED")).isEqualTo(1);
            MvcResult replay=create(organizer,"cross-race",payload);
            assertThat(etag(replay)).isEqualTo(etag(scheduled));
            assertThat(contains(list(member,"PARTICIPANT"),mid)).isTrue();
            assertThat(contains(list(organizer,"ORGANIZER"),mid)).isTrue();
        } finally {
            begin.countDown();
            pool.shutdownNow();
        }
    }
}
