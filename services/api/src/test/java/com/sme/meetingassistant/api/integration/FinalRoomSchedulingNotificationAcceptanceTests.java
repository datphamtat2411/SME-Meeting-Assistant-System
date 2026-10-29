package com.sme.meetingassistant.api.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.meeting.notification.MeetingParticipantRemovedEmailHandler;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.LinkedHashMap;
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
import tools.jackson.databind.ObjectMapper;

/**
 * T09 independent acceptance: real HTTP requests each commit separately, and
 * PostgreSQL is the authority for room occupancy, participant access and email intents.
 * Existing T03/T04/T06 and T07/T08 suites cover lower-level races and SMTP retries.
 */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class FinalRoomSchedulingNotificationAcceptanceTests {
    private static final String NINE = "2031-02-18T09:00:00Z";
    private static final String TEN = "2031-02-18T10:00:00Z";
    private static final String ELEVEN = "2031-02-18T11:00:00Z";
    private static final String TWELVE = "2031-02-18T12:00:00Z";

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired MeetingParticipantRemovedEmailHandler removedHandler;

    UUID admin, organizer, member, secondMember, outsider;

    @BeforeEach void fixture() {
        admin = user("ADMINISTRATOR");
        organizer = user("EMPLOYEE");
        member = user("EMPLOYEE");
        secondMember = user("EMPLOYEE");
        outsider = user("EMPLOYEE");
    }

    private UUID user(String role) {
        UUID id = UUID.randomUUID();
        String email = email(id);
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,
                global_role,account_status)
            VALUES (?,?,?,'T09 cross-module fixture','test-only',?,'ACTIVE')
            """, id, email, email, role);
        return id;
    }

    private static String email(UUID id) { return "t09-" + id + "@example.invalid"; }
    private static Principal as(UUID userId) { return () -> userId.toString(); }
    private String jsonBody(Object body) throws Exception { return json.writeValueAsString(body); }
    private UUID id(MvcResult result) throws Exception {
        return UUID.fromString(json.readTree(result.getResponse().getContentAsString())
            .path("data").path("id").asText());
    }
    private String etag(MvcResult result) { return result.getResponse().getHeader(HttpHeaders.ETAG); }

    private UUID createRoom() throws Exception {
        MvcResult response = mvc.perform(post("/api/v1/rooms").principal(as(admin))
            .contentType(MediaType.APPLICATION_JSON).content(jsonBody(
                Map.of("code","T09-"+UUID.randomUUID(),"name","T09 Acceptance Room","capacity",8))))
            .andExpect(status().isCreated()).andReturn();
        return id(response);
    }

    private MvcResult create(UUID who,UUID room,String start,String end,UUID... people) throws Exception {
        Map<String,Object> data = new LinkedHashMap<>();
        data.put("title","Private integration review T09");
        data.put("scheduledStartAt",start);
        data.put("scheduledEndAt",end);
        if (room != null) data.put("roomId",room);
        data.put("participantUserIds",List.of(people));
        return mvc.perform(post("/api/v1/meetings").principal(as(who))
            .contentType(MediaType.APPLICATION_JSON).content(jsonBody(data)))
            .andExpect(status().isCreated()).andReturn();
    }
    private MvcResult detail(UUID mid,UUID who) throws Exception {
        return mvc.perform(get("/api/v1/meetings/"+mid).principal(as(who)))
            .andExpect(status().isOk()).andReturn();
    }
    private MvcResult command(UUID mid,UUID who,String action,String version) throws Exception {
        return mvc.perform(post("/api/v1/meetings/"+mid+"/"+action).principal(as(who))
            .header(HttpHeaders.IF_MATCH,version))
            .andExpect(status().isOk()).andReturn();
    }
    private MvcResult add(UUID mid,UUID who,UUID target,String version) throws Exception {
        return mvc.perform(post("/api/v1/meetings/"+mid+"/participants")
            .principal(as(who)).header(HttpHeaders.IF_MATCH,version)
            .contentType(MediaType.APPLICATION_JSON)
            .content(jsonBody(Map.of("userId",target))))
            .andExpect(status().isCreated()).andReturn();
    }
    private MvcResult remove(UUID mid,UUID who,UUID target,String version) throws Exception {
        return mvc.perform(delete("/api/v1/meetings/"+mid+"/participants/"+target)
            .principal(as(who)).header(HttpHeaders.IF_MATCH,version))
            .andExpect(status().isOk()).andReturn();
    }
    private MvcResult reschedule(UUID mid,UUID who,String version,UUID room,
            String start,String end) throws Exception {
        Map<String,Object> patch = new LinkedHashMap<>();
        patch.put("scheduledStartAt",start);
        patch.put("scheduledEndAt",end);
        if(room != null) patch.put("roomId",room);
        return mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
            .patch("/api/v1/meetings/"+mid).principal(as(who))
            .header(HttpHeaders.IF_MATCH,version).contentType(MediaType.APPLICATION_JSON)
            .content(jsonBody(patch))).andExpect(status().isOk()).andReturn();
    }
    private int meetingEmail(UUID mid,String purpose,String state,UUID userId) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries
            WHERE related_entity_type='MEETING' AND related_entity_id=?
              AND notification_type=? AND status=? AND recipient_user_id=?
            """,Integer.class,mid,purpose,state,userId);
    }
    private int memberEmail(UUID mid,String purpose,String state,UUID userId) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries e
            JOIN meeting_participants p ON p.id=e.related_entity_id
            WHERE e.related_entity_type='MEETING_PARTICIPANT' AND p.meeting_id=?
              AND e.notification_type=? AND e.status=? AND e.recipient_user_id=?
            """,Integer.class,mid,purpose,state,userId);
    }
    private int reservations(UUID mid,String state) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM room_reservations WHERE meeting_id=? AND status=?
            """,Integer.class,mid,state);
    }

    @Test void roomBookingMembershipRescheduleCancellationAndHistoryStayConsistent()
            throws Exception {
        UUID roomA = createRoom(), roomB = createRoom();
        MvcResult draft = create(organizer,roomA,NINE,TEN,member);
        UUID mid = id(draft);
        MvcResult booked = command(mid,organizer,"schedule",etag(draft));
        assertThat(reservations(mid,"ACTIVE")).isEqualTo(1);
        assertThat(meetingEmail(mid,"MEETING_SCHEDULED","PENDING",member)).isEqualTo(1);

        add(mid,organizer,secondMember,etag(booked));
        assertThat(memberEmail(mid,"MEETING_PARTICIPANT_ADDED","PENDING",secondMember))
            .isEqualTo(1);
        remove(mid,organizer,member,etag(detail(mid,organizer)));
        assertThat(meetingEmail(mid,"MEETING_SCHEDULED","SKIPPED",member)).isEqualTo(1);
        assertThat(memberEmail(mid,"MEETING_PARTICIPANT_REMOVED","PENDING",member))
            .isEqualTo(1);
        mvc.perform(get("/api/v1/meetings/"+mid).principal(as(member)))
            .andExpect(status().isNotFound());

        MvcResult moved = reschedule(mid,organizer,etag(detail(mid,organizer)),roomB,TEN,ELEVEN);
        assertThat(reservations(mid,"ACTIVE")).isEqualTo(1);
        assertThat(reservations(mid,"RELEASED")).isEqualTo(1);
        assertThat(memberEmail(mid,"MEETING_PARTICIPANT_ADDED","SKIPPED",secondMember))
            .isEqualTo(1);
        assertThat(meetingEmail(mid,"MEETING_RESCHEDULED","PENDING",organizer)).isEqualTo(1);
        assertThat(meetingEmail(mid,"MEETING_RESCHEDULED","PENDING",secondMember)).isEqualTo(1);
        assertThat(meetingEmail(mid,"MEETING_RESCHEDULED","PENDING",member)).isZero();

        command(mid,organizer,"cancel",etag(moved));
        assertThat(reservations(mid,"ACTIVE")).isZero();
        assertThat(reservations(mid,"RELEASED")).isEqualTo(2);
        assertThat(meetingEmail(mid,"MEETING_RESCHEDULED","SKIPPED",organizer)).isEqualTo(1);
        assertThat(meetingEmail(mid,"MEETING_RESCHEDULED","SKIPPED",secondMember)).isEqualTo(1);
        assertThat(meetingEmail(mid,"MEETING_CANCELLED","PENDING",organizer)).isEqualTo(1);
        assertThat(meetingEmail(mid,"MEETING_CANCELLED","PENDING",secondMember)).isEqualTo(1);
        assertThat(meetingEmail(mid,"MEETING_CANCELLED","PENDING",member)).isZero();
        assertThat(memberEmail(mid,"MEETING_PARTICIPANT_REMOVED","PENDING",member))
            .isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_participants
            WHERE meeting_id=? AND user_id=? AND removed_at IS NOT NULL
            """,Integer.class,mid,member)).isEqualTo(1);
        assertThat(removedHandler.compose(
            jdbc.queryForObject("""
                SELECT id FROM meeting_participants
                WHERE meeting_id=? AND user_id=? AND removed_at IS NOT NULL
                """,UUID.class,mid,member),email(member))).isPresent();
    }

    @Test void supersessionDoesNotMutateUnrelatedMeetingsEvenForSameRecipient() throws Exception {
        MvcResult one = create(organizer,null,NINE,TEN);
        MvcResult two = create(organizer,null,TEN,ELEVEN);
        UUID a=id(one),b=id(two);
        MvcResult scheduledA=command(a,organizer,"schedule",etag(one));
        MvcResult scheduledB=command(b,organizer,"schedule",etag(two));
        add(a,organizer,member,etag(scheduledA));
        add(b,organizer,member,etag(scheduledB));
        assertThat(memberEmail(a,"MEETING_PARTICIPANT_ADDED","PENDING",member)).isEqualTo(1);
        assertThat(memberEmail(b,"MEETING_PARTICIPANT_ADDED","PENDING",member)).isEqualTo(1);

        remove(a,organizer,member,etag(detail(a,organizer)));
        assertThat(memberEmail(a,"MEETING_PARTICIPANT_ADDED","SKIPPED",member)).isEqualTo(1);
        assertThat(memberEmail(a,"MEETING_PARTICIPANT_REMOVED","PENDING",member)).isEqualTo(1);
        assertThat(memberEmail(b,"MEETING_PARTICIPANT_ADDED","PENDING",member)).isEqualTo(1);
        command(a,organizer,"cancel",etag(detail(a,organizer)));
        assertThat(memberEmail(b,"MEETING_PARTICIPANT_ADDED","PENDING",member)).isEqualTo(1);
        assertThat(meetingEmail(b,"MEETING_SCHEDULED","PENDING",organizer)).isEqualTo(1);
        mvc.perform(get("/api/v1/meetings/"+a).principal(as(member)))
            .andExpect(status().isNotFound());
        mvc.perform(get("/api/v1/meetings/"+b).principal(as(member)))
            .andExpect(status().isOk());
    }

    @Test void failedRoomRescheduleCannotInvalidateAnUnrelatedPendingMemberInvitation()
            throws Exception {
        UUID roomA=createRoom(),roomB=createRoom();
        MvcResult first=create(organizer,roomA,NINE,TEN);
        MvcResult other=create(outsider,roomB,TEN,ELEVEN);
        UUID a=id(first), b=id(other);
        MvcResult firstBooked=command(a,organizer,"schedule",etag(first));
        command(b,outsider,"schedule",etag(other));
        add(a,organizer,member,etag(firstBooked));
        MvcResult current=detail(a,organizer);

        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
            .patch("/api/v1/meetings/"+a).principal(as(organizer))
            .header(HttpHeaders.IF_MATCH,etag(current))
            .contentType(MediaType.APPLICATION_JSON)
            .content(jsonBody(Map.of("roomId",roomB,
                "scheduledStartAt",TEN,"scheduledEndAt",ELEVEN))))
            .andExpect(status().isConflict());

        assertThat(memberEmail(a,"MEETING_PARTICIPANT_ADDED","PENDING",member)).isEqualTo(1);
        assertThat(memberEmail(a,"MEETING_PARTICIPANT_ADDED","SKIPPED",member)).isZero();
        assertThat(meetingEmail(a,"MEETING_SCHEDULED","PENDING",organizer)).isEqualTo(1);
        assertThat(meetingEmail(a,"MEETING_RESCHEDULED","PENDING",organizer)).isZero();
        assertThat(reservations(a,"ACTIVE")).isEqualTo(1);
        assertThat(reservations(a,"RELEASED")).isZero();
        assertThat(jdbc.queryForObject("""
            SELECT room_id FROM meetings WHERE id=?
            """,UUID.class,a)).isEqualTo(roomA);
        assertThat(etag(detail(a,organizer))).isEqualTo(etag(current));
    }

    @Test void queuedFailedAndClaimedSendingNoticesKeepDistinctOutcomes() throws Exception {
        MvcResult draft=create(organizer,null,NINE,TEN,member);
        UUID mid=id(draft);
        MvcResult booked=command(mid,organizer,"schedule",etag(draft));
        jdbc.update("""
            UPDATE email_deliveries SET status='FAILED',
                last_error_code='SMTP_DELIVERY_FAILED',
                next_attempt_at=clock_timestamp()
            WHERE related_entity_type='MEETING' AND related_entity_id=?
              AND notification_type='MEETING_SCHEDULED' AND recipient_user_id=?
            """,mid,member);
        jdbc.update("""
            UPDATE email_deliveries SET status='SENDING',
                attempt_count=1,updated_at=clock_timestamp()
            WHERE related_entity_type='MEETING' AND related_entity_id=?
              AND notification_type='MEETING_SCHEDULED' AND recipient_user_id=?
            """,mid,organizer);

        MvcResult moved=reschedule(mid,organizer,etag(booked),null,TEN,ELEVEN);
        assertThat(meetingEmail(mid,"MEETING_SCHEDULED","SKIPPED",member)).isEqualTo(1);
        assertThat(meetingEmail(mid,"MEETING_SCHEDULED","SENDING",organizer)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT skip_reason FROM email_deliveries
            WHERE related_entity_type='MEETING' AND related_entity_id=?
              AND notification_type='MEETING_SCHEDULED' AND recipient_user_id=?
            """,String.class,mid,member)).isEqualTo("SUPERSEDED_BY_MEETING_CHANGE");
        command(mid,organizer,"cancel",etag(moved));
        assertThat(meetingEmail(mid,"MEETING_SCHEDULED","SENDING",organizer)).isEqualTo(1);
        assertThat(meetingEmail(mid,"MEETING_RESCHEDULED","SKIPPED",member)).isEqualTo(1);
        assertThat(meetingEmail(mid,"MEETING_CANCELLED","PENDING",member)).isEqualTo(1);
        assertThat(meetingEmail(mid,"MEETING_CANCELLED","PENDING",organizer)).isEqualTo(1);
    }

    @Test void administratorDoesNotBypassPrivateMembershipOrGenerateGhostEmail()
            throws Exception {
        MvcResult draft=create(organizer,null,NINE,TEN,member);
        UUID mid=id(draft);
        MvcResult booked=command(mid,organizer,"schedule",etag(draft));
        mvc.perform(get("/api/v1/meetings/"+mid).principal(as(admin)))
            .andExpect(status().isNotFound());
        mvc.perform(post("/api/v1/meetings/"+mid+"/participants")
            .principal(as(admin)).header(HttpHeaders.IF_MATCH,etag(booked))
            .contentType(MediaType.APPLICATION_JSON)
            .content(jsonBody(Map.of("userId",secondMember))))
            .andExpect(status().isNotFound());
        mvc.perform(delete("/api/v1/meetings/"+mid+"/participants/"+member)
            .principal(as(admin)).header(HttpHeaders.IF_MATCH,etag(booked)))
            .andExpect(status().isNotFound());
        assertThat(memberEmail(mid,"MEETING_PARTICIPANT_ADDED","PENDING",secondMember))
            .isZero();
        assertThat(memberEmail(mid,"MEETING_PARTICIPANT_REMOVED","PENDING",member))
            .isZero();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_participants
            WHERE meeting_id=? AND user_id=? AND removed_at IS NULL
            """,Integer.class,mid,member)).isEqualTo(1);
        assertThat(reservations(mid,"ACTIVE")).isZero();
        assertThat(etag(detail(mid,organizer))).isEqualTo(etag(booked));
    }
}
