package com.sme.meetingassistant.api.dashboard;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.authentication.entity.AuthClientType;
import com.sme.meetingassistant.api.authentication.entity.AuthSessionEntity;
import com.sme.meetingassistant.api.authentication.repository.AuthSessionRepository;
import com.sme.meetingassistant.api.authentication.security.Rs256AccessTokenService;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupPasswordHasher;
import java.security.Principal;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpHeaders;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * DE-03 HTTP through Spring context, authenticated server principal, real
 * PostgreSQL 17 Testcontainers, Flyway and DE-02 authorization-scoped SQL ports.
 *
 * No outer test transaction: authorization revocations are committed and
 * re-evaluated in a new transaction for each HTTP request.
 */
@ActiveProfiles("test")
@SpringBootTest(properties = "app.action-items.business-zone=Asia/Ho_Chi_Minh")
@AutoConfigureMockMvc
@Import({PostgresTestConfiguration.class, PersonalDashboardHttpIntegrationTests.FixedClock.class})
class PersonalDashboardHttpIntegrationTests {
    private static final Instant NOW = Instant.parse("2026-11-06T18:30:00Z");
    private static final ZoneId BUSINESS_ZONE = ZoneId.of("Asia/Ho_Chi_Minh");

    @TestConfiguration(proxyBeanMethods = false)
    static class FixedClock {
        @Bean
        @Primary
        Clock fixedDashboardTestClock() {
            return Clock.fixed(NOW, ZoneOffset.UTC);
        }
    }

    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired ObjectMapper json;
    @Autowired UserRepository userRepository;
    @Autowired AuthSessionRepository authSessions;
    @Autowired AccountSetupPasswordHasher passwordHasher;
    @Autowired Rs256AccessTokenService jwtTokens;

    @Test
    void overviewShowsOnlyAuthorizedMeetingsAndCanonicalActionCounts() throws Exception {
        UUID alice = user("EMPLOYEE");
        UUID bob = user("EMPLOYEE");
        UUID outsider = user("EMPLOYEE");
        UUID admin = user("ADMINISTRATOR");
        UUID own = meeting(alice, "SCHEDULED", NOW.plus(Duration.ofHours(2)), null);
        participant(own, alice); // organizer and participant are one meeting
        UUID invited = meeting(bob, "SCHEDULED", NOW.plus(Duration.ofDays(2)), null);
        participant(invited, alice);
        UUID far = meeting(alice, "SCHEDULED", NOW.plus(Duration.ofDays(16)), null);
        UUID recent = meeting(bob, "ENDED", null, NOW.minus(Duration.ofDays(4)));
        participant(recent, alice);
        UUID old = meeting(alice, "ENDED", null, NOW.minus(Duration.ofDays(40)));
        UUID hidden = meeting(outsider, "SCHEDULED", NOW.plus(Duration.ofHours(1)), null);

        JsonNode response = data(request(alice).get());
        assertThat(response.path("upcomingMeetings").size()).isEqualTo(2);
        assertThat(ids(response.path("upcomingMeetings"))).containsExactly(own, invited)
            .doesNotContain(far, hidden);
        assertThat(ids(response.path("recentMeetings"))).containsExactly(recent)
            .doesNotContain(old);
        assertThat(response.path("meetingCountsByState").path("SCHEDULED").asLong()).isEqualTo(3);
        assertThat(response.path("meetingCountsByState").path("ENDED").asLong()).isEqualTo(2);
        assertThat(response.path("assignedActionItems").path("overdue").asLong()).isZero();
        assertThat(response.path("asOf").asText()).isEqualTo("2026-11-06T18:30:00Z");
        assertThat(response.path("timezone").asText()).isEqualTo("Asia/Ho_Chi_Minh");
        assertThat(response.path("upcomingWindow").path("limit").asInt()).isEqualTo(10);
        assertThat(response.path("recentWindow").path("fromInclusive").asText())
            .isEqualTo("2026-10-07T18:30:00Z");
        // D06 remains undecided: no fictitious pendingReview or "failed meetings" KPI.
        assertThat(response.has("processingAttention")).isFalse();
        assertThat(response.has("processingJobStates")).isFalse();

        JsonNode administrator = data(request(admin).get());
        assertThat(administrator.path("upcomingMeetings").size()).isZero();
        assertThat(administrator.path("meetingCountsByState").path("SCHEDULED").asLong())
            .isZero();
    }

    @Test
    void assignedOfficialWorkIncludesExternalAssigneeButNeverMeetingContents() throws Exception {
        UUID organizer = user("EMPLOYEE");
        UUID externalAssignee = user("EMPLOYEE");
        UUID meeting = meeting(organizer, "SCHEDULED", NOW.plus(Duration.ofDays(1)), null);
        LocalDate today = NOW.atZone(BUSINESS_ZONE).toLocalDate();
        assertThat(today).isEqualTo(LocalDate.of(2026, 11, 7));
        assertThat(NOW.atZone(ZoneOffset.UTC).toLocalDate())
            .isEqualTo(LocalDate.of(2026, 11, 6));

        action(meeting, organizer, externalAssignee, today.minusDays(1), "OPEN");
        action(meeting, organizer, externalAssignee, today, "OPEN");
        action(meeting, organizer, externalAssignee, null, "OPEN");
        action(meeting, organizer, externalAssignee, today.minusDays(1), "IN_PROGRESS");
        action(meeting, organizer, externalAssignee, today.minusDays(2), "DONE");
        action(meeting, organizer, externalAssignee, today.minusDays(2), "CANCELLED");

        JsonNode own = data(request(externalAssignee).get());
        assertThat(own.path("assignedActionItems").path("open").asLong()).isEqualTo(3);
        assertThat(own.path("assignedActionItems").path("inProgress").asLong()).isEqualTo(1);
        assertThat(own.path("assignedActionItems").path("done").asLong()).isEqualTo(1);
        assertThat(own.path("assignedActionItems").path("overdue").asLong()).isEqualTo(2);
        assertThat(own.path("upcomingMeetings").size()).isZero();
        assertThat(own.path("meetingCountsByState").path("SCHEDULED").asLong()).isZero();
        // No source/provenance or action item details are in the personal dashboard.
        assertThat(own.toString()).doesNotContain(meeting.toString(), "processingJobId",
            "transcript", "summary");

        JsonNode organizerView = data(request(organizer).get());
        assertThat(organizerView.path("assignedActionItems").path("open").asLong()).isZero();
        assertThat(organizerView.path("upcomingMeetings").size()).isEqualTo(1);
    }

    @Test
    void membershipRevocationAndDeactivationAreEffectiveOnNextRequest() throws Exception {
        UUID organizer = user("EMPLOYEE");
        UUID member = user("EMPLOYEE");
        UUID meeting = meeting(organizer, "SCHEDULED", NOW.plus(Duration.ofHours(3)), null);
        participant(meeting, member);
        assertThat(ids(data(request(member).get()).path("upcomingMeetings")))
            .containsExactly(meeting);

        jdbc.update("UPDATE meeting_participants SET removed_at=CURRENT_TIMESTAMP "
                + "WHERE meeting_id=? AND user_id=? AND removed_at IS NULL",
                meeting, member);
        JsonNode revoked = data(request(member).get());
        assertThat(revoked.path("upcomingMeetings").size()).isZero();
        assertThat(revoked.path("meetingCountsByState").path("SCHEDULED").asLong())
            .isZero();

        jdbc.update("UPDATE users SET account_status='INACTIVE' WHERE id=?", member);
        MvcResult denied = mvc.perform(get("/api/v1/dashboard/me").principal(principal(member)))
                .andExpect(status().isUnauthorized()).andReturn();
        assertThat(json.readTree(denied.getResponse().getContentAsString())
                .path("code").asText()).isEqualTo("AUTH_REQUIRED");
    }

    @Test
    void boundedWindowsAreHalfOpenAndListsUseStableOrdering() throws Exception {
        UUID alice = user("EMPLOYEE");
        Instant sameTime = NOW.plus(Duration.ofHours(2));
        UUID a = meeting(alice, "SCHEDULED", sameTime, null);
        UUID b = meeting(alice, "SCHEDULED", sameTime, null);
        UUID exclusiveStart = meeting(alice, "SCHEDULED", NOW.plus(Duration.ofDays(7)), null);
        UUID endedInside = meeting(alice, "ENDED", null, NOW.minus(Duration.ofDays(2)));
        UUID endedExclusive = meeting(alice, "ENDED", null, NOW.minus(Duration.ofDays(3)));

        JsonNode bounded = data(request(alice, "upcomingDays", "7",
                "recentDays", "3", "limit", "2").get());
        List<UUID> expected = new ArrayList<>(List.of(a, b));
        expected.sort(Comparator.comparing(UUID::toString));
        assertThat(ids(bounded.path("upcomingMeetings"))).containsExactlyElementsOf(expected);
        assertThat(ids(bounded.path("upcomingMeetings"))).doesNotContain(exclusiveStart);
        assertThat(ids(bounded.path("recentMeetings"))).containsExactly(endedInside)
                .doesNotContain(endedExclusive);
        assertThat(bounded.path("upcomingWindow").path("toExclusive").asText())
            .isEqualTo("2026-11-13T18:30:00Z");
        assertThat(bounded.path("recentWindow").path("limit").asInt()).isEqualTo(2);

        JsonNode first = data(request(alice, "limit", "1").get());
        assertThat(ids(first.path("upcomingMeetings"))).containsExactly(expected.getFirst());
    }

    @Test
    void invalidFiltersUseValidationEnvelopeAndMalformedValuesAreRejected() throws Exception {
        UUID alice = user("EMPLOYEE");
        for (String[] bad : List.of(
                new String[]{"upcomingDays", "0"},
                new String[]{"upcomingDays", "91"},
                new String[]{"recentDays", "0"},
                new String[]{"recentDays", "100"},
                new String[]{"limit", "0"},
                new String[]{"limit", "51"})) {
            MvcResult rejected = mvc.perform(get("/api/v1/dashboard/me")
                    .principal(principal(alice)).param(bad[0], bad[1]))
                    .andExpect(status().isUnprocessableEntity()).andReturn();
            JsonNode body = json.readTree(rejected.getResponse().getContentAsString());
            assertThat(body.path("success").asBoolean()).isFalse();
            assertThat(body.path("code").asText()).isEqualTo("VALIDATION_FAILED");
        }
        MvcResult malformed = mvc.perform(get("/api/v1/dashboard/me")
                .principal(principal(alice)).param("limit", "a lot"))
                .andExpect(status().isBadRequest()).andReturn();
        assertThat(json.readTree(malformed.getResponse().getContentAsString())
                .path("code").asText()).isEqualTo("MALFORMED_REQUEST");
    }

    @Test
    void signedJwtAndLiveSessionAreRequiredByActualHttpSecurityChain() throws Exception {
        UserEntity signedUser = new UserEntity("de03-token-" + UUID.randomUUID()
                + "@example.invalid", "DE03 JWT fixture", GlobalRole.EMPLOYEE, null);
        signedUser.completeInitialSetup(passwordHasher.hash(
                "DE03 live-session Argon2id test password 2026!"),
                OffsetDateTime.now(ZoneOffset.UTC));
        signedUser = userRepository.saveAndFlush(signedUser);

        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        AuthSessionEntity session = authSessions.saveAndFlush(
                new AuthSessionEntity(signedUser.getId(), AuthClientType.MOBILE,
                        now, now.plusDays(1), null));
        session.recordActivity(now);
        authSessions.saveAndFlush(session);
        String token = jwtTokens.issue(signedUser.getId(), session.getId());

        MvcResult valid = mvc.perform(get("/api/v1/dashboard/me")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
                .andExpect(status().isOk()).andReturn();
        assertThat(data(valid).path("upcomingMeetings").size()).isZero();

        mvc.perform(get("/api/v1/dashboard/me")
                .header(HttpHeaders.AUTHORIZATION, "Bearer invalid.jwt.token"))
                .andExpect(status().isUnauthorized());
        mvc.perform(get("/api/v1/dashboard/me")
                .header("X-User-Id", signedUser.getId().toString()))
                .andExpect(status().isUnauthorized());

        session.revoke(OffsetDateTime.now(ZoneOffset.UTC), "LOGOUT");
        authSessions.saveAndFlush(session);
        mvc.perform(get("/api/v1/dashboard/me")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void emptyStateIsRealZeroAndResponseHasNoStoreCommonEnvelope() throws Exception {
        UUID actor = user("EMPLOYEE");
        MvcResult result = request(actor).get();
        JsonNode body = json.readTree(result.getResponse().getContentAsString());
        assertThat(result.getResponse().getHeader(HttpHeaders.CACHE_CONTROL))
            .contains("no-store");
        assertThat(body.path("success").asBoolean()).isTrue();
        assertThat(body.path("code").asText()).isEqualTo("SUCCESS");
        assertThat(body.path("meta").path("requestId").asText()).isNotEmpty();
        assertThat(body.path("meta").path("timestamp").asText()).isNotEmpty();
        assertThat(body.path("data").path("upcomingMeetings").size()).isZero();
        assertThat(body.path("data").path("recentMeetings").size()).isZero();
        assertThat(body.path("data").path("meetingCountsByState").path("DRAFT").asLong())
            .isZero();
        assertThat(body.path("data").path("assignedActionItems").path("open").asLong())
            .isZero();
    }

    private Request request(UUID actor, String... params) {
        return new Request(actor, params);
    }

    private final class Request {
        private final UUID actor;
        private final String[] params;

        Request(UUID actor, String[] params) {
            this.actor = actor;
            this.params = params;
        }

        MvcResult get() throws Exception {
            var req = get("/api/v1/dashboard/me").principal(principal(actor));
            if (params.length % 2 != 0) throw new IllegalArgumentException("Bad test params");
            for (int i = 0; i < params.length; i += 2) req.param(params[i], params[i+1]);
            return mvc.perform(req).andExpect(status().isOk()).andReturn();
        }
    }

    private JsonNode data(MvcResult result) throws Exception {
        return json.readTree(result.getResponse().getContentAsString()).path("data");
    }

    private static Principal principal(UUID actor) {
        return () -> actor.toString();
    }

    private static List<UUID> ids(JsonNode rows) {
        List<UUID> ids = new ArrayList<>();
        for (JsonNode row : rows) ids.add(UUID.fromString(row.path("id").asText()));
        return ids;
    }

    private UUID user(String role) {
        UUID id = UUID.randomUUID();
        String email = "de03-" + id + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'DE03 test actor','test-only',?,'ACTIVE')
            """, id, email, email, role);
        return id;
    }

    private UUID meeting(UUID organizer, String status, Instant scheduled, Instant actualEnd) {
        UUID id = UUID.randomUUID();
        OffsetDateTime scheduledStart = scheduled == null ? null : utc(scheduled);
        OffsetDateTime scheduledEnd = scheduled == null ? null : utc(scheduled.plus(Duration.ofHours(1)));
        OffsetDateTime started = actualEnd == null ? null : utc(actualEnd.minus(Duration.ofHours(1)));
        OffsetDateTime ended = actualEnd == null ? null : utc(actualEnd);
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id,status,
                scheduled_start_at,scheduled_end_at,started_at,ended_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, id, "DE03 meeting " + id, organizer, organizer,
                status, scheduledStart, scheduledEnd, started, ended);
        return id;
    }

    private void participant(UUID meetingId, UUID userId) {
        jdbc.update("INSERT INTO meeting_participants(id,meeting_id,user_id) VALUES (?,?,?)",
                UUID.randomUUID(), meetingId, userId);
    }

    private UUID action(UUID meetingId, UUID creator, UUID assignee,
            LocalDate due, String targetStatus) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO action_items(id,meeting_id,title,status,assignee_user_id,
                                     due_date,source_type,created_by_user_id)
            VALUES (?,?,?,'OPEN',?,?,'MANUAL',?)
            """, id, meetingId, "DE03 official task", assignee, due, creator);
        if ("IN_PROGRESS".equals(targetStatus)) {
            jdbc.update("UPDATE action_items SET status='IN_PROGRESS', version=version+1 WHERE id=?", id);
        } else if ("DONE".equals(targetStatus)) {
            jdbc.update("""
                UPDATE action_items SET status='DONE', completed_by_user_id=?,
                    completed_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=?
                """, assignee, id);
        } else if ("CANCELLED".equals(targetStatus)) {
            jdbc.update("""
                UPDATE action_items SET status='CANCELLED', cancelled_by_user_id=?,
                    cancelled_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=?
                """, creator, id);
        } else if (!"OPEN".equals(targetStatus)) {
            throw new IllegalArgumentException(targetStatus);
        }
        return id;
    }

    private static OffsetDateTime utc(Instant instant) {
        return instant.atOffset(ZoneOffset.UTC);
    }
}
