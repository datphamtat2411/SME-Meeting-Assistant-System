package com.sme.meetingassistant.api.meetingintelligence;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.meeting.service.MeetingIntelligenceAccess;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.service.AuthenticatedUserId;
import java.security.Principal;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Test-only adapter exposes the Meeting-owned port through the same request identity
 * and exception handling as eventual MI-04/MI-06 controllers. No production route
 * is created before MI-02 has implemented persistence and business operations.
 */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import({PostgresTestConfiguration.class, MeetingIntelligenceAccessIntegrationTests.ProbeController.class})
@Transactional
class MeetingIntelligenceAccessIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;

    UUID meeting, organizer, participant, outsider, administrator, inactive;

    @BeforeEach
    void setup() {
        organizer = user("EMPLOYEE", "ACTIVE");
        participant = user("EMPLOYEE", "ACTIVE");
        outsider = user("EMPLOYEE", "ACTIVE");
        administrator = user("ADMINISTRATOR", "ACTIVE");
        inactive = user("EMPLOYEE", "INACTIVE");
        meeting = UUID.randomUUID();
        jdbc.update("INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id) "
            + "VALUES (?, 'Meeting intelligence authorization test', ?, ?)",
            meeting, organizer, organizer);
        jdbc.update("INSERT INTO meeting_participants(id,meeting_id,user_id,added_by_user_id) "
            + "VALUES (?,?,?,?)", UUID.randomUUID(), meeting, participant, organizer);
    }

    private UUID user(String role, String status) {
        UUID id = UUID.randomUUID();
        String email = "mi03-" + id + "@example.invalid";
        jdbc.update("INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status) "
            + "VALUES (?,?,?,'MI03 tester','test-only',?,?)", id, email, email, role, status);
        return id;
    }

    private static Principal as(UUID id) {
        return () -> id.toString();
    }

    private String url(String operation) {
        return "/api/v1/_mi03-test/meetings/" + meeting + "/" + operation;
    }

    @Test
    void currentOrganizerAndParticipantCanReadButUnrelatedAdminCannot() throws Exception {
        mvc.perform(get(url("read")).principal(as(organizer))).andExpect(status().isOk());
        mvc.perform(get(url("read")).principal(as(participant))).andExpect(status().isOk());
        mvc.perform(get(url("read")).principal(as(outsider))).andExpect(status().isNotFound());
        mvc.perform(get(url("read")).principal(as(administrator))).andExpect(status().isNotFound());
        mvc.perform(get(url("read")).principal(as(inactive))).andExpect(status().isUnauthorized());
        mvc.perform(get(url("read"))).andExpect(status().isUnauthorized());
    }

    @Test
    void onlyOrganizerMayEditOrReviewMeetingIntelligence() throws Exception {
        for (String operation : new String[] {"edit-summary", "edit-decision", "review-decision"}) {
            mvc.perform(post(url(operation)).principal(as(organizer))).andExpect(status().isOk());
            mvc.perform(post(url(operation)).principal(as(participant))).andExpect(status().isNotFound());
            mvc.perform(post(url(operation)).principal(as(administrator))).andExpect(status().isNotFound());
        }
    }

    @Test
    void processingAdmissionUsesExistingCancellationRule() throws Exception {
        mvc.perform(post(url("regenerate")).principal(as(organizer))).andExpect(status().isOk());
        mvc.perform(post(url("regenerate")).principal(as(participant))).andExpect(status().isNotFound());
        jdbc.update("UPDATE meetings SET status='CANCELLED' WHERE id=?", meeting);
        mvc.perform(post(url("regenerate")).principal(as(organizer))).andExpect(status().isConflict());
    }

    @Test
    void revokedMembershipAffectsNextContentRead() throws Exception {
        mvc.perform(get(url("read")).principal(as(participant))).andExpect(status().isOk());
        jdbc.update("UPDATE meeting_participants SET removed_at=CURRENT_TIMESTAMP "
            + "WHERE meeting_id=? AND user_id=?", meeting, participant);
        mvc.perform(get(url("read")).principal(as(participant))).andExpect(status().isNotFound());
    }

    @Test
    void differentAuthenticatedActorCannotBorrowAnotherActorsIdentity() throws Exception {
        mvc.perform(get(url("spoof")).principal(as(outsider))).andExpect(status().isNotFound());
    }

    @RestController
    @RequestMapping("/api/v1/_mi03-test/meetings/{meetingId}")
    static class ProbeController {
        private final MeetingIntelligenceAccess access;
        private final AuthenticatedUserId principal;

        ProbeController(MeetingIntelligenceAccess access, AuthenticatedUserId principal) {
            this.access = access;
            this.principal = principal;
        }

        @GetMapping("/read")
        public String read(@PathVariable UUID meetingId) {
            access.requireIntelligenceReadable(meetingId, principal.requireUserId());
            return "OK";
        }

        @GetMapping("/spoof")
        public String spoof(@PathVariable UUID meetingId) {
            access.requireIntelligenceReadable(meetingId, UUID.randomUUID());
            return "OK";
        }

        @PostMapping("/edit-summary")
        public String editSummary(@PathVariable UUID meetingId) {
            access.requireSummaryEditAllowed(meetingId, principal.requireUserId());
            return "OK";
        }

        @PostMapping("/edit-decision")
        public String editDecision(@PathVariable UUID meetingId) {
            access.requireDecisionEditAllowed(meetingId, principal.requireUserId());
            return "OK";
        }

        @PostMapping("/review-decision")
        public String reviewDecision(@PathVariable UUID meetingId) {
            access.requireDecisionReviewAllowed(meetingId, principal.requireUserId());
            return "OK";
        }

        @PostMapping("/regenerate")
        public String regenerate(@PathVariable UUID meetingId) {
            access.requireSummaryRegenerationAllowed(meetingId, principal.requireUserId());
            return "OK";
        }
    }
}
