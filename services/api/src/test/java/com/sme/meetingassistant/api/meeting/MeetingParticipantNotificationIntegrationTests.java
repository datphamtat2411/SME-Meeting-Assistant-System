package com.sme.meetingassistant.api.meeting;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.meeting.notification.MeetingParticipantAddedEmailHandler;
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
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;

/**
 * T08 HTTP -> committed Meeting + historical membership + durable delivery.
 * No test-wide transaction: endpoint commits and rollback must be genuine.
 */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class MeetingParticipantNotificationIntegrationTests {
    private static final String START = "2030-12-22T09:00:00Z";
    private static final String END = "2030-12-22T10:00:00Z";
    private static final String LATER = "2030-12-22T11:00:00Z";

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired MeetingParticipantAddedEmailHandler addedHandler;
    @Autowired MeetingParticipantRemovedEmailHandler removedHandler;
    @Autowired PlatformTransactionManager txManager;
    UUID owner, member, other;
    String memberEmail;

    @BeforeEach void setup() {
        owner = user();
        member = user();
        other = user();
        memberEmail = email(member);
    }

    private static String email(UUID id) { return "t08-" + id + "@example.invalid"; }
    private UUID user() {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'T08 fixture','test-only','EMPLOYEE','ACTIVE')
            """, id, email(id), email(id));
        return id;
    }
    private static Principal as(UUID who) { return () -> who.toString(); }
    private String payload(Object data) throws Exception { return json.writeValueAsString(data); }
    private UUID id(MvcResult r) throws Exception {
        return UUID.fromString(json.readTree(r.getResponse().getContentAsString())
            .path("data").path("id").asText());
    }
    private String tag(MvcResult r) { return r.getResponse().getHeader(HttpHeaders.ETAG); }
    private MvcResult detail(UUID mid) throws Exception {
        return mvc.perform(get("/api/v1/meetings/" + mid).principal(as(owner)))
            .andExpect(status().isOk()).andReturn();
    }
    private MvcResult draft(UUID... invitees) throws Exception {
        Map<String,Object> body = new LinkedHashMap<>();
        body.put("title", "Private T08 organizer planning");
        body.put("scheduledStartAt",START);
        body.put("scheduledEndAt",END);
        body.put("participantUserIds",List.of(invitees));
        return mvc.perform(post("/api/v1/meetings").principal(as(owner))
            .contentType(MediaType.APPLICATION_JSON).content(payload(body)))
            .andExpect(status().isCreated()).andReturn();
    }
    private MvcResult action(UUID mid,String action,String version) throws Exception {
        return mvc.perform(post("/api/v1/meetings/" + mid + "/" + action)
            .principal(as(owner)).header(HttpHeaders.IF_MATCH,version))
            .andExpect(status().isOk()).andReturn();
    }
    private MvcResult add(UUID mid,UUID recipient,String version) throws Exception {
        return mvc.perform(post("/api/v1/meetings/" + mid + "/participants")
            .principal(as(owner)).header(HttpHeaders.IF_MATCH,version)
            .contentType(MediaType.APPLICATION_JSON).content(payload(Map.of("userId",recipient))))
            .andExpect(status().isCreated()).andReturn();
    }
    private MvcResult remove(UUID mid,UUID recipient,String version) throws Exception {
        return mvc.perform(delete("/api/v1/meetings/" + mid + "/participants/" + recipient)
            .principal(as(owner)).header(HttpHeaders.IF_MATCH,version))
            .andExpect(status().isOk()).andReturn();
    }
    private UUID activeRow(UUID mid,UUID uid) {
        return jdbc.queryForObject("""
            SELECT id FROM meeting_participants
            WHERE meeting_id=? AND user_id=? AND removed_at IS NULL
            """,UUID.class,mid,uid);
    }
    private int deliveries(UUID mid,String type,String state,UUID recipient) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries d
            JOIN meeting_participants p ON p.id=d.related_entity_id
            WHERE p.meeting_id=? AND d.related_entity_type='MEETING_PARTICIPANT'
              AND d.notification_type=? AND d.status=? AND d.recipient_user_id=?
            """,Integer.class,mid,type,state,recipient);
    }
    private int scheduled(UUID mid,String state,UUID uid) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries
            WHERE related_entity_type='MEETING' AND related_entity_id=?
              AND notification_type='MEETING_SCHEDULED' AND recipient_user_id=? AND status=?
            """,Integer.class,mid,uid,state);
    }

    @Test void draftMembershipChangesDoNotGenerateEmailsAndScheduleSendsOneInvitation() throws Exception {
        MvcResult created=draft();
        UUID mid=id(created);
        add(mid,member,tag(created));
        assertThat(deliveries(mid,"MEETING_PARTICIPANT_ADDED","PENDING",member)).isZero();
        MvcResult afterAdd=detail(mid);
        remove(mid,member,tag(afterAdd));
        assertThat(deliveries(mid,"MEETING_PARTICIPANT_REMOVED","PENDING",member)).isZero();
        MvcResult afterRemove=detail(mid);
        add(mid,member,tag(afterRemove));
        MvcResult afterReadd=detail(mid);
        action(mid,"schedule",tag(afterReadd));
        assertThat(scheduled(mid,"PENDING",member)).isEqualTo(1);
        assertThat(deliveries(mid,"MEETING_PARTICIPANT_ADDED","PENDING",member)).isZero();
    }

    @Test void addingToScheduledMeetingCreatesOneRecipientSpecificInvitation() throws Exception {
        MvcResult created=draft();
        UUID mid=id(created);
        MvcResult scheduled=action(mid,"schedule",tag(created));
        MvcResult added=add(mid,member,tag(scheduled));
        UUID membership= id(added);
        assertThat(deliveries(mid,"MEETING_PARTICIPANT_ADDED","PENDING",member)).isEqualTo(1);
        assertThat(deliveries(mid,"MEETING_PARTICIPANT_ADDED","PENDING",owner)).isZero();
        assertThat(deliveries(mid,"MEETING_PARTICIPANT_ADDED","PENDING",other)).isZero();
        var mail=addedHandler.compose(membership,memberEmail);
        assertThat(mail).isPresent();
        assertThat(mail.orElseThrow().body()).doesNotContain("Private T08",mid.toString());
        assertThat(addedHandler.compose(membership,email(other))).isEmpty();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_participants
            WHERE meeting_id=? AND user_id=? AND removed_at IS NULL
            """,Integer.class,mid,member)).isEqualTo(1);
    }

    @Test void removedMemberLosesAccessButReceivesContentSafeRemovalNotice() throws Exception {
        MvcResult created=draft();
        UUID mid=id(created);
        MvcResult scheduled=action(mid,"schedule",tag(created));
        add(mid,member,tag(scheduled));
        UUID membership=activeRow(mid,member);
        MvcResult last=detail(mid);
        remove(mid,member,tag(last));
        mvc.perform(get("/api/v1/meetings/"+mid).principal(as(member)))
            .andExpect(status().isNotFound());
        assertThat(deliveries(mid,"MEETING_PARTICIPANT_ADDED","SKIPPED",member)).isEqualTo(1);
        assertThat(deliveries(mid,"MEETING_PARTICIPANT_REMOVED","PENDING",member)).isEqualTo(1);
        assertThat(addedHandler.compose(membership,memberEmail)).isEmpty();
        var mail=removedHandler.compose(membership,memberEmail);
        assertThat(mail).isPresent();
        assertThat(mail.orElseThrow().body()).doesNotContain("Private T08",mid.toString(),
            START, END);
        assertThat(removedHandler.compose(membership,email(other))).isEmpty();
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_participants
            WHERE id=? AND removed_at IS NOT NULL
            """,Integer.class,membership)).isEqualTo(1);
    }

    @Test void removalInvalidatesOnlyRecipientsPendingScheduledMail() throws Exception {
        MvcResult created=draft(member,other);
        UUID mid=id(created);
        MvcResult scheduled=action(mid,"schedule",tag(created));
        assertThat(scheduled(mid,"PENDING",member)).isEqualTo(1);
        remove(mid,member,tag(scheduled));
        assertThat(scheduled(mid,"SKIPPED",member)).isEqualTo(1);
        assertThat(scheduled(mid,"PENDING",member)).isZero();
        assertThat(scheduled(mid,"PENDING",other)).isEqualTo(1);
        assertThat(scheduled(mid,"PENDING",owner)).isEqualTo(1);
        assertThat(deliveries(mid,"MEETING_PARTICIPANT_REMOVED","PENDING",member)).isEqualTo(1);
    }

    @Test void removeThenReaddSupersedesStaleRemovalWithFreshMembershipEvent() throws Exception {
        MvcResult created=draft();
        UUID mid=id(created);
        MvcResult scheduled=action(mid,"schedule",tag(created));
        add(mid,member,tag(scheduled));
        UUID first=activeRow(mid,member);
        MvcResult afterAdd=detail(mid);
        remove(mid,member,tag(afterAdd));
        assertThat(removedHandler.compose(first,memberEmail)).isPresent();
        MvcResult afterRemove=detail(mid);
        add(mid,member,tag(afterRemove));
        UUID second=activeRow(mid,member);
        assertThat(second).isNotEqualTo(first);
        assertThat(deliveries(mid,"MEETING_PARTICIPANT_ADDED","SKIPPED",member)).isEqualTo(1);
        assertThat(deliveries(mid,"MEETING_PARTICIPANT_REMOVED","SKIPPED",member)).isEqualTo(1);
        assertThat(deliveries(mid,"MEETING_PARTICIPANT_ADDED","PENDING",member)).isEqualTo(1);
        assertThat(removedHandler.compose(first,memberEmail)).isEmpty();
        assertThat(addedHandler.compose(second,memberEmail)).isPresent();
    }

    @Test void materialRescheduleInvalidatesNewMemberInviteAndSendsRescheduleToThem()
            throws Exception {
        MvcResult created=draft();
        UUID mid=id(created);
        MvcResult scheduled=action(mid,"schedule",tag(created));
        add(mid,member,tag(scheduled));
        MvcResult current=detail(mid);
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
            .patch("/api/v1/meetings/"+mid).principal(as(owner))
            .header(HttpHeaders.IF_MATCH,tag(current)).contentType(MediaType.APPLICATION_JSON)
            .content(payload(Map.of("scheduledEndAt",LATER))))
            .andExpect(status().isOk());
        assertThat(deliveries(mid,"MEETING_PARTICIPANT_ADDED","SKIPPED",member)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries WHERE related_entity_id=?
              AND notification_type='MEETING_RESCHEDULED' AND recipient_user_id=?
              AND status='PENDING'
            """,Integer.class,mid,member)).isEqualTo(1);
    }

    @Test void cancellationInvalidatesPendingMemberAddAndNotifiesActiveMember() throws Exception {
        MvcResult created=draft();
        UUID mid=id(created);
        MvcResult scheduled=action(mid,"schedule",tag(created));
        add(mid,member,tag(scheduled));
        MvcResult current=detail(mid);
        action(mid,"cancel",tag(current));
        assertThat(deliveries(mid,"MEETING_PARTICIPANT_ADDED","SKIPPED",member)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM email_deliveries
            WHERE related_entity_id=? AND notification_type='MEETING_CANCELLED'
              AND recipient_user_id=? AND status='PENDING'
            """,Integer.class,mid,member)).isEqualTo(1);
    }

    @Test void staleIfMatchAndDuplicateMembershipDoNotEnqueueGhostEvents() throws Exception {
        MvcResult created=draft();
        UUID mid=id(created);
        MvcResult scheduled=action(mid,"schedule",tag(created));
        mvc.perform(post("/api/v1/meetings/"+mid+"/participants")
            .principal(as(owner)).header(HttpHeaders.IF_MATCH,tag(created))
            .contentType(MediaType.APPLICATION_JSON)
            .content(payload(Map.of("userId",member))))
            .andExpect(status().isPreconditionFailed());
        assertThat(deliveries(mid,"MEETING_PARTICIPANT_ADDED","PENDING",member)).isZero();
        add(mid,member,tag(scheduled));
        mvc.perform(post("/api/v1/meetings/"+mid+"/participants")
            .principal(as(owner)).header(HttpHeaders.IF_MATCH,tag(detail(mid)))
            .contentType(MediaType.APPLICATION_JSON)
            .content(payload(Map.of("userId",member))))
            .andExpect(status().isConflict());
        assertThat(deliveries(mid,"MEETING_PARTICIPANT_ADDED","PENDING",member)).isEqualTo(1);
    }

    @Test void inProgressMembershipChangesDoNotSendScheduleInvites() throws Exception {
        MvcResult created=draft();
        UUID mid=id(created);
        MvcResult scheduled=action(mid,"schedule",tag(created));
        MvcResult started=action(mid,"start",tag(scheduled));
        add(mid,member,tag(started));
        MvcResult now=detail(mid);
        remove(mid,member,tag(now));
        assertThat(deliveries(mid,"MEETING_PARTICIPANT_ADDED","PENDING",member)).isZero();
        assertThat(deliveries(mid,"MEETING_PARTICIPANT_REMOVED","PENDING",member)).isZero();
    }

    @Test void rolledBackParticipantAddDoesNotPersistMembershipOrEmail() throws Exception {
        MvcResult created=draft();
        UUID mid=id(created);
        MvcResult booked=action(mid,"schedule",tag(created));
        String version=tag(booked);
        new TransactionTemplate(txManager).executeWithoutResult(tx -> {
            try {
                add(mid,member,version);
                assertThat(deliveries(mid,"MEETING_PARTICIPANT_ADDED","PENDING",member))
                    .isEqualTo(1);
                tx.setRollbackOnly();
            } catch (Exception error) {
                throw new IllegalStateException(error);
            }
        });
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_participants
            WHERE meeting_id=? AND user_id=? AND removed_at IS NULL
            """,Integer.class,mid,member)).isZero();
        assertThat(deliveries(mid,"MEETING_PARTICIPANT_ADDED","PENDING",member)).isZero();
        assertThat(tag(detail(mid))).isEqualTo(version);
    }

    @Test void rolledBackRemovalPreservesMembershipAndOriginalInvitation() throws Exception {
        MvcResult created=draft(member);
        UUID mid=id(created);
        MvcResult booked=action(mid,"schedule",tag(created));
        String version=tag(booked);
        new TransactionTemplate(txManager).executeWithoutResult(tx -> {
            try {
                remove(mid,member,version);
                assertThat(deliveries(mid,"MEETING_PARTICIPANT_REMOVED","PENDING",member))
                    .isEqualTo(1);
                tx.setRollbackOnly();
            } catch (Exception error) {
                throw new IllegalStateException(error);
            }
        });
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM meeting_participants
            WHERE meeting_id=? AND user_id=? AND removed_at IS NULL
            """,Integer.class,mid,member)).isEqualTo(1);
        assertThat(scheduled(mid,"PENDING",member)).isEqualTo(1);
        assertThat(deliveries(mid,"MEETING_PARTICIPANT_REMOVED","PENDING",member)).isZero();
        mvc.perform(get("/api/v1/meetings/"+mid).principal(as(member)))
            .andExpect(status().isOk());
        assertThat(tag(detail(mid))).isEqualTo(version);
    }

    @Test void inactiveRecipientCannotReceivePendingMembershipEmails() throws Exception {
        MvcResult created=draft();
        UUID mid=id(created);
        MvcResult scheduled=action(mid,"schedule",tag(created));
        add(mid,member,tag(scheduled));
        UUID membership=activeRow(mid,member);
        jdbc.update("UPDATE users SET account_status='INACTIVE' WHERE id=?",member);
        assertThat(addedHandler.compose(membership,memberEmail)).isEmpty();
        assertThat(removedHandler.compose(membership,memberEmail)).isEmpty();
    }
}
