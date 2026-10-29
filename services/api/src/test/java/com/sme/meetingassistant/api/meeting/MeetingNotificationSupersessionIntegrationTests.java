package com.sme.meetingassistant.api.meeting;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.meeting.notification.MeetingCancelledEmailHandler;
import com.sme.meetingassistant.api.meeting.notification.MeetingScheduledEmailHandler;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.security.Principal;
import java.util.LinkedHashMap;
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
 * T07: real HTTP commits + PostgreSQL durable queue. No test-wide transaction:
 * a rejected meeting command must roll back reservation and mail disposition together.
 */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class MeetingNotificationSupersessionIntegrationTests {
    private static final String NINE = "2030-12-21T09:00:00Z";
    private static final String TEN = "2030-12-21T10:00:00Z";
    private static final String ELEVEN = "2030-12-21T11:00:00Z";
    private static final String TWELVE = "2030-12-21T12:00:00Z";

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired MeetingCancelledEmailHandler cancellation;
    @Autowired MeetingScheduledEmailHandler scheduling;
    UUID organizer;
    String organizerEmail;

    @BeforeEach void setupUser() {
        organizer = UUID.randomUUID();
        organizerEmail = "t07-" + organizer + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'T07 fixture','test-only','EMPLOYEE','ACTIVE')
            """, organizer, organizerEmail, organizerEmail);
    }

    private Principal principal() { return () -> organizer.toString(); }
    private String tag(MvcResult response) { return response.getResponse().getHeader(HttpHeaders.ETAG); }
    private UUID id(MvcResult response) throws Exception {
        return UUID.fromString(json.readTree(response.getResponse().getContentAsString())
            .path("data").path("id").asText());
    }
    private UUID room() {
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO rooms(id,code,name) VALUES (?,?,?)",
            id, "T07-" + id, "T07 Room");
        return id;
    }
    private MvcResult draft(UUID room, String start, String end) throws Exception {
        Map<String,Object> body = new LinkedHashMap<>();
        body.put("title", "T07 lifecycle");
        body.put("scheduledStartAt", start);
        body.put("scheduledEndAt", end);
        body.put("roomId", room);
        return mvc.perform(post("/api/v1/meetings").principal(principal())
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body)))
            .andExpect(status().isCreated()).andReturn();
    }
    private MvcResult command(UUID meeting, String action, String etag) throws Exception {
        return mvc.perform(post("/api/v1/meetings/" + meeting + "/" + action)
            .principal(principal()).header(HttpHeaders.IF_MATCH, etag))
            .andExpect(status().isOk()).andReturn();
    }
    private MvcResult patch(UUID meeting, String etag, Map<String,?> changes) throws Exception {
        return mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
            .patch("/api/v1/meetings/" + meeting).principal(principal())
            .header(HttpHeaders.IF_MATCH, etag).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(changes)))
            .andExpect(status().isOk()).andReturn();
    }
    private int count(UUID meeting, String type, String deliveryStatus) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries
             WHERE related_entity_id=? AND related_entity_type='MEETING'
               AND notification_type=? AND status=?
            """, Integer.class, meeting, type, deliveryStatus);
    }
    private String singleReason(UUID meeting, String type) {
        return jdbc.queryForObject("""
            SELECT skip_reason FROM email_deliveries
            WHERE related_entity_id=? AND notification_type=?
            ORDER BY created_at,id LIMIT 1
            """, String.class, meeting, type);
    }

    @Test void cancelSupersedesUnsentScheduleAndKeepsCancellationDeliverable() throws Exception {
        MvcResult draft = draft(null, NINE, TEN);
        UUID meeting = id(draft);
        MvcResult scheduled = command(meeting,"schedule",tag(draft));
        assertThat(count(meeting,"MEETING_SCHEDULED","PENDING")).isEqualTo(1);
        command(meeting,"cancel",tag(scheduled));

        assertThat(count(meeting,"MEETING_SCHEDULED","SKIPPED")).isEqualTo(1);
        assertThat(singleReason(meeting,"MEETING_SCHEDULED"))
            .isEqualTo("SUPERSEDED_BY_MEETING_CHANGE");
        assertThat(count(meeting,"MEETING_CANCELLED","PENDING")).isEqualTo(1);
        assertThat(cancellation.compose(meeting,organizerEmail)).isPresent();
        assertThat(scheduling.compose(meeting,organizerEmail)).isEmpty();
    }

    @Test void repeatedRescheduleThenCancelOnlyKeepsTheLatestIntent() throws Exception {
        MvcResult draft = draft(null,NINE,TEN);
        UUID meeting = id(draft);
        MvcResult scheduled = command(meeting,"schedule",tag(draft));
        MvcResult first = patch(meeting,tag(scheduled),Map.of(
            "scheduledStartAt",TEN,"scheduledEndAt",ELEVEN));
        assertThat(count(meeting,"MEETING_SCHEDULED","SKIPPED")).isEqualTo(1);
        assertThat(count(meeting,"MEETING_RESCHEDULED","PENDING")).isEqualTo(1);
        MvcResult second = patch(meeting,tag(first),Map.of(
            "scheduledStartAt",ELEVEN,"scheduledEndAt",TWELVE));
        assertThat(count(meeting,"MEETING_RESCHEDULED","SKIPPED")).isEqualTo(1);
        assertThat(count(meeting,"MEETING_RESCHEDULED","PENDING")).isEqualTo(1);
        command(meeting,"cancel",tag(second));
        assertThat(count(meeting,"MEETING_RESCHEDULED","SKIPPED")).isEqualTo(2);
        assertThat(count(meeting,"MEETING_RESCHEDULED","PENDING")).isZero();
        assertThat(count(meeting,"MEETING_CANCELLED","PENDING")).isEqualTo(1);
    }

    @Test void failedRetryIsSupersededAndRetryScheduleCleared() throws Exception {
        MvcResult draft = draft(null,NINE,TEN);
        UUID meeting = id(draft);
        MvcResult scheduled = command(meeting,"schedule",tag(draft));
        jdbc.update("""
            UPDATE email_deliveries SET status='FAILED',
                last_error_code='SMTP_DELIVERY_FAILED', next_attempt_at=clock_timestamp()
            WHERE related_entity_id=? AND notification_type='MEETING_SCHEDULED'
            """,meeting);
        patch(meeting,tag(scheduled),Map.of("scheduledEndAt",ELEVEN));
        assertThat(count(meeting,"MEETING_SCHEDULED","SKIPPED")).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT next_attempt_at FROM email_deliveries
            WHERE related_entity_id=? AND notification_type='MEETING_SCHEDULED'
            """, java.sql.Timestamp.class,meeting)).isNull();
        assertThat(jdbc.queryForObject("""
            SELECT last_error_code FROM email_deliveries
            WHERE related_entity_id=? AND notification_type='MEETING_SCHEDULED'
            """, String.class,meeting)).isNull();
        assertThat(count(meeting,"MEETING_RESCHEDULED","PENDING")).isEqualTo(1);
    }

    @Test void metadataOnlyChangeDoesNotSupersedeScheduledEmail() throws Exception {
        MvcResult draft = draft(null,NINE,TEN);
        UUID meeting = id(draft);
        MvcResult scheduled = command(meeting,"schedule",tag(draft));
        patch(meeting,tag(scheduled),Map.of("title","Metadata only"));
        assertThat(count(meeting,"MEETING_SCHEDULED","PENDING")).isEqualTo(1);
        assertThat(count(meeting,"MEETING_SCHEDULED","SKIPPED")).isZero();
    }

    @Test void startingAndEndingStopUnsentScheduleNotices() throws Exception {
        MvcResult draft = draft(null,NINE,TEN);
        UUID meeting = id(draft);
        MvcResult scheduled = command(meeting,"schedule",tag(draft));
        MvcResult started = command(meeting,"start",tag(scheduled));
        assertThat(count(meeting,"MEETING_SCHEDULED","SKIPPED")).isEqualTo(1);
        command(meeting,"end",tag(started));
        assertThat(count(meeting,"MEETING_SCHEDULED","SKIPPED")).isEqualTo(1);
        assertThat(count(meeting,"MEETING_CANCELLED","PENDING")).isZero();
    }

    @Test void sentMailHistoryRemainsIntactWhenMeetingCancels() throws Exception {
        MvcResult draft = draft(null,NINE,TEN);
        UUID meeting = id(draft);
        MvcResult scheduled = command(meeting,"schedule",tag(draft));
        jdbc.update("""
            UPDATE email_deliveries SET status='SENT',sent_at=clock_timestamp()
            WHERE related_entity_id=? AND notification_type='MEETING_SCHEDULED'
            """,meeting);
        command(meeting,"cancel",tag(scheduled));
        assertThat(count(meeting,"MEETING_SCHEDULED","SENT")).isEqualTo(1);
        assertThat(count(meeting,"MEETING_SCHEDULED","SKIPPED")).isZero();
        assertThat(count(meeting,"MEETING_CANCELLED","PENDING")).isEqualTo(1);
    }

    @Test void conflictingRescheduleRollsBackMeetingAndDoesNotSupersede() throws Exception {
        UUID room = room();
        MvcResult firstDraft = draft(room,NINE,TEN);
        UUID firstId = id(firstDraft);
        MvcResult first = command(firstId,"schedule",tag(firstDraft));
        MvcResult secondDraft = draft(room,TEN,ELEVEN);
        command(id(secondDraft),"schedule",tag(secondDraft));

        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
            .patch("/api/v1/meetings/"+firstId).principal(principal())
            .header(HttpHeaders.IF_MATCH,tag(first))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of(
                "scheduledStartAt",TEN,"scheduledEndAt",ELEVEN))))
            .andExpect(status().isConflict());

        assertThat(count(firstId,"MEETING_SCHEDULED","PENDING")).isEqualTo(1);
        assertThat(count(firstId,"MEETING_SCHEDULED","SKIPPED")).isZero();
        assertThat(count(firstId,"MEETING_RESCHEDULED","PENDING")).isZero();
        assertThat(jdbc.queryForObject("""
            SELECT scheduled_start_at FROM meetings WHERE id=?
            """, java.time.OffsetDateTime.class,firstId).toInstant())
            .isEqualTo(java.time.OffsetDateTime.parse(NINE).toInstant());
    }

    @Test void staleIfMatchCannotSupersedeOrEnqueueEmail() throws Exception {
        MvcResult draft = draft(null,NINE,TEN);
        UUID meeting = id(draft);
        command(meeting,"schedule",tag(draft));
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
            .patch("/api/v1/meetings/"+meeting).principal(principal())
            .header(HttpHeaders.IF_MATCH,tag(draft))
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("scheduledEndAt",ELEVEN))))
            .andExpect(status().isPreconditionFailed());
        assertThat(count(meeting,"MEETING_SCHEDULED","PENDING")).isEqualTo(1);
        assertThat(count(meeting,"MEETING_RESCHEDULED","PENDING")).isZero();
    }
}
