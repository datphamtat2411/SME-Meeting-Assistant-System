package com.sme.meetingassistant.api.dashboard;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.authentication.entity.AuthClientType;
import com.sme.meetingassistant.api.authentication.entity.AuthSessionEntity;
import com.sme.meetingassistant.api.authentication.repository.AuthSessionRepository;
import com.sme.meetingassistant.api.authentication.security.Rs256AccessTokenService;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupPasswordHasher;
import java.security.Principal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
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
 * DE-04 HTTP + real PostgreSQL/Flyway+Spring Security boundary.
 * No wrapping test transaction: revocation/role changes are committed before
 * the next request, and the feature query starts its own REPEATABLE_READ view.
 */
@ActiveProfiles("test")
@SpringBootTest(properties = "app.action-items.business-zone=Asia/Ho_Chi_Minh")
@AutoConfigureMockMvc
@Import({PostgresTestConfiguration.class, ManagementDashboardHttpIntegrationTests.FixedClock.class})
class ManagementDashboardHttpIntegrationTests {
    private static final Instant AS_OF = Instant.parse("2026-11-06T18:30:00Z");
    private static final String FROM = "2026-11-01T00:00:00Z";
    private static final String TO = "2026-11-15T00:00:00Z";
    private static final LocalDate LOCAL_TODAY = LocalDate.of(2026, 11, 7);

    @TestConfiguration(proxyBeanMethods = false)
    static class FixedClock {
        @Bean
        @Primary
        Clock fixedManagementDashboardTestClock() {
            return Clock.fixed(AS_OF, ZoneOffset.UTC);
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
    void aggregateTwoGrantedUnitsWithoutDoubleCountingOrUnauthorizedMeetingContent() throws Exception {
        UUID u1 = unit(), u2 = unit(), foreign = unit();
        UUID manager = user("DEPARTMENT_MANAGER");
        UUID organizer = user("EMPLOYEE");
        UUID external = user("EMPLOYEE");
        grant(manager, u1);
        grant(manager, u2);
        UUID a = meeting(organizer, u1);
        UUID b = meeting(organizer, u2);
        UUID forbiddenMeeting = meeting(external, foreign);
        UUID noScope = meeting(external, null);

        action(a, organizer, external, "OPEN", LOCAL_TODAY.minusDays(1), at("2026-11-05T12:00:00Z"));
        action(a, organizer, external, "OPEN", LOCAL_TODAY, at("2026-11-05T12:00:00Z"));
        action(a, organizer, external, "IN_PROGRESS", LOCAL_TODAY.minusDays(1), at("2026-11-05T12:00:00Z"));
        action(a, organizer, external, "DONE", LOCAL_TODAY.minusDays(2), at("2026-11-05T12:00:00Z"));
        action(a, organizer, external, "CANCELLED", LOCAL_TODAY.minusDays(2), at("2026-11-05T12:00:00Z"));
        action(b, organizer, external, "OPEN", LOCAL_TODAY.minusDays(1), at("2026-11-05T12:00:00Z"));
        action(forbiddenMeeting, external, external, "OPEN", LOCAL_TODAY.minusDays(1), at("2026-11-05T12:00:00Z"));
        action(noScope, external, external, "OPEN", LOCAL_TODAY.minusDays(1), at("2026-11-05T12:00:00Z"));

        MvcResult result = request(manager, FROM, TO, null).get();
        JsonNode data = data(result);
        JsonNode actions = data.path("actionItems");
        assertThat(actions.path("open").asLong()).isEqualTo(3);
        assertThat(actions.path("inProgress").asLong()).isEqualTo(1);
        assertThat(actions.path("done").asLong()).isEqualTo(1);
        assertThat(actions.path("cancelled").asLong()).isEqualTo(1);
        assertThat(actions.path("overdue").asLong()).isEqualTo(3);
        assertThat(actions.path("totalOfficial").asLong()).isEqualTo(6);
        assertThat(data.path("period").path("cohortTimeField").asText())
                .isEqualTo("ACTION_ITEM_CREATED_AT");
        assertThat(data.path("period").path("statusTimeSemantics").asText())
                .isEqualTo("CURRENT_STATE");
        assertThat(data.path("scope").path("type").asText())
                .isEqualTo("MANAGED_OFFICIAL_ACTION_ITEMS");
        assertThat(ids(data.path("scope").path("organizationalUnitIds")))
                .containsExactlyInAnyOrder(u1, u2);
        assertThat(data.path("timezone").asText()).isEqualTo("Asia/Ho_Chi_Minh");
        assertThat(data.path("asOf").asText()).isEqualTo("2026-11-06T18:30:00Z");

        // There is no approved organization-wide Meeting or AI reporting permission.
        assertThat(data.path("unavailableMetrics").size()).isEqualTo(3);
        assertThat(data.has("meetingCountsByState")).isFalse();
        assertThat(data.has("processingOutcomes")).isFalse();
        assertThat(data.has("completionRate")).isFalse();
        assertThat(data.toString()).doesNotContain(a.toString(), b.toString(),
                forbiddenMeeting.toString(), "transcript", "summary", "processingJobId");

        assertThat(result.getResponse().getHeader(HttpHeaders.CACHE_CONTROL))
                .contains("no-store");
        JsonNode body = json.readTree(result.getResponse().getContentAsString());
        assertThat(body.path("success").asBoolean()).isTrue();
        assertThat(body.path("code").asText()).isEqualTo("SUCCESS");
        assertThat(body.path("meta").path("requestId").asText()).isNotBlank();
    }

    @Test
    void exactUnitFilterDoesNotIncludeOtherGrantsOrUnauthorizedOrgIds() throws Exception {
        UUID u1 = unit(), u2 = unit(), u3 = unit();
        UUID manager = user("DEPARTMENT_MANAGER");
        UUID organizer = user("EMPLOYEE");
        grant(manager, u1);
        grant(manager, u2);
        action(meeting(organizer, u1), organizer, organizer, "OPEN",
                LOCAL_TODAY.minusDays(1), at("2026-11-05T01:00:00Z"));
        action(meeting(organizer, u2), organizer, organizer, "DONE",
                LOCAL_TODAY.minusDays(1), at("2026-11-05T01:00:00Z"));
        action(meeting(organizer, u3), organizer, organizer, "OPEN",
                LOCAL_TODAY.minusDays(1), at("2026-11-05T01:00:00Z"));

        JsonNode scoped = data(request(manager, FROM, TO, u1).get());
        assertThat(scoped.path("actionItems").path("open").asLong()).isEqualTo(1L);
        assertThat(scoped.path("actionItems").path("done").asLong()).isZero();
        assertThat(scoped.path("actionItems").path("totalOfficial").asLong()).isEqualTo(1L);
        assertThat(ids(scoped.path("scope").path("organizationalUnitIds"))).containsExactly(u1);

        JsonNode other = data(request(manager, FROM, TO, u2).get());
        assertThat(other.path("actionItems").path("open").asLong()).isZero();
        assertThat(other.path("actionItems").path("done").asLong()).isEqualTo(1L);
        mvc.perform(get("/api/v1/dashboard/management")
                .principal(principal(manager)).param("from", FROM).param("to", TO)
                .param("orgUnitId", u3.toString()))
                .andExpect(status().isForbidden());
        // Missing and out-of-scope IDs are rejected by the same fail-closed policy.
        mvc.perform(get("/api/v1/dashboard/management")
                .principal(principal(manager)).param("from", FROM).param("to", TO)
                .param("orgUnitId", UUID.randomUUID().toString()))
                .andExpect(status().isForbidden());
    }

    @Test
    void employeesAdministratorsAndUnscopedManagersAreForbiddenNotZeroFilled() throws Exception {
        UUID managerNoGrant = user("DEPARTMENT_MANAGER");
        UUID employee = user("EMPLOYEE");
        UUID admin = user("ADMINISTRATOR");
        for (UUID actor : List.of(managerNoGrant, employee, admin)) {
            var result = mvc.perform(get("/api/v1/dashboard/management")
                    .principal(principal(actor)).param("from", FROM).param("to", TO))
                    .andExpect(status().isForbidden()).andReturn();
            assertThat(json.readTree(result.getResponse().getContentAsString())
                    .path("code").asText()).isEqualTo("AUTHZ_FORBIDDEN");
        }
        mvc.perform(get("/api/v1/dashboard/management")
                .header("X-User-Id", admin.toString())
                .param("from", FROM).param("to", TO))
                .andExpect(status().isUnauthorized());

        UUID scoped = user("DEPARTMENT_MANAGER");
        grant(scoped, unit());
        jdbc.update("UPDATE users SET account_status='INACTIVE' WHERE id=?", scoped);
        var result = mvc.perform(get("/api/v1/dashboard/management")
                .principal(principal(scoped)).param("from", FROM).param("to", TO))
                .andExpect(status().isUnauthorized()).andReturn();
        assertThat(json.readTree(result.getResponse().getContentAsString())
                .path("code").asText()).isEqualTo("AUTH_REQUIRED");
    }

    @Test
    void roleGrantAndUnitRevocationsApplyOnNextRequestWithoutRetroactiveReclassification()
            throws Exception {
        UUID unit1 = unit(), unit2 = unit();
        UUID manager = user("DEPARTMENT_MANAGER");
        UUID organizer = user("EMPLOYEE");
        grant(manager, unit1);
        grant(manager, unit2);
        UUID m1 = meeting(organizer, unit1);
        UUID m2 = meeting(organizer, unit2);
        action(m1, organizer, organizer, "OPEN", LOCAL_TODAY.minusDays(1), at("2026-11-05T01:00:00Z"));
        action(m2, organizer, organizer, "OPEN", LOCAL_TODAY.minusDays(1), at("2026-11-05T01:00:00Z"));

        assertThat(data(request(manager, FROM, TO, null).get())
                .path("actionItems").path("open").asLong()).isEqualTo(2L);

        // Organizer transfer does NOT mutate immutable V30 action-item unit scope.
        jdbc.update("UPDATE users SET primary_org_unit_id=? WHERE id=?", unit2, organizer);
        assertThat(data(request(manager, FROM, TO, unit1).get())
                .path("actionItems").path("open").asLong()).isEqualTo(1L);

        jdbc.update("DELETE FROM manager_scope_units WHERE user_id=? AND org_unit_id=?",
                manager, unit2);
        assertThat(data(request(manager, FROM, TO, null).get())
                .path("actionItems").path("open").asLong()).isEqualTo(1L);
        mvc.perform(get("/api/v1/dashboard/management").principal(principal(manager))
                .param("from", FROM).param("to", TO)
                .param("orgUnitId", unit2.toString())).andExpect(status().isForbidden());

        jdbc.update("UPDATE organizational_units SET status='INACTIVE' WHERE id=?", unit1);
        mvc.perform(get("/api/v1/dashboard/management").principal(principal(manager))
                .param("from", FROM).param("to", TO)).andExpect(status().isForbidden());

        jdbc.update("UPDATE organizational_units SET status='ACTIVE' WHERE id=?", unit1);
        assertThat(data(request(manager, FROM, TO, null).get())
                .path("actionItems").path("open").asLong()).isEqualTo(1L);
        jdbc.update("UPDATE users SET global_role='EMPLOYEE' WHERE id=?", manager);
        mvc.perform(get("/api/v1/dashboard/management").principal(principal(manager))
                .param("from", FROM).param("to", TO)).andExpect(status().isForbidden());
    }

    @Test
    void halfOpenCreatedAtCohortUsesAbsoluteOffsetsAndCurrentNotHistoricalStatuses()
            throws Exception {
        UUID manager = user("DEPARTMENT_MANAGER"), organizer = user("EMPLOYEE");
        UUID u = unit();
        grant(manager, u);
        UUID meeting = meeting(organizer, u);
        UUID atLower = action(meeting, organizer, organizer, "OPEN",
                LOCAL_TODAY.minusDays(1), at("2026-11-01T00:00:00Z"));
        action(meeting, organizer, organizer, "DONE",
                LOCAL_TODAY.minusDays(1), at("2026-11-07T12:00:00Z"));
        action(meeting, organizer, organizer, "OPEN",
                LOCAL_TODAY.minusDays(1), at("2026-11-15T00:00:00Z"));
        action(meeting, organizer, organizer, "OPEN",
                LOCAL_TODAY.minusDays(1), at("2026-10-31T23:59:59Z"));

        JsonNode view = data(request(manager,
                "2026-11-01T07:00:00+07:00",
                "2026-11-15T07:00:00+07:00", null).get());
        assertThat(view.path("actionItems").path("totalOfficial").asLong()).isEqualTo(2L);
        assertThat(view.path("actionItems").path("open").asLong()).isEqualTo(1L);
        assertThat(view.path("actionItems").path("done").asLong()).isEqualTo(1L);
        assertThat(view.path("actionItems").path("overdue").asLong()).isEqualTo(1L);
        assertThat(view.path("period").path("fromInclusive").asText())
                .isEqualTo("2026-11-01T00:00:00Z");
        assertThat(view.path("period").path("toExclusive").asText())
                .isEqualTo("2026-11-15T00:00:00Z");

        // An item's current state (not a historical completion event) drives the KPI.
        jdbc.update("UPDATE action_items SET status='IN_PROGRESS', version=version+1 WHERE id=?",
                atLower);
        JsonNode after = data(request(manager, FROM, TO, null).get());
        assertThat(after.path("actionItems").path("open").asLong()).isZero();
        assertThat(after.path("actionItems").path("inProgress").asLong()).isEqualTo(1L);
        assertThat(after.path("actionItems").path("overdue").asLong()).isEqualTo(1L);
    }

    @Test
    void emptyAuthorizedCohortIsZeroButValidationAndOutOfRangeAreExplicit() throws Exception {
        UUID manager = user("DEPARTMENT_MANAGER");
        UUID orgUnit = unit();
        grant(manager, orgUnit);
        JsonNode empty = data(request(manager, FROM, TO, null).get());
        assertThat(empty.path("actionItems").path("totalOfficial").asLong()).isZero();
        assertThat(empty.path("actionItems").path("overdue").asLong()).isZero();
        assertThat(ids(empty.path("scope").path("organizationalUnitIds")))
                .containsExactly(orgUnit);

        for (String[] interval : List.of(
                new String[]{TO, FROM},
                new String[]{FROM, FROM},
                new String[]{"2020-01-01T00:00:00Z", "2026-11-15T00:00:00Z"})) {
            var error = mvc.perform(get("/api/v1/dashboard/management")
                    .principal(principal(manager)).param("from", interval[0])
                    .param("to", interval[1]))
                    .andExpect(status().isUnprocessableEntity()).andReturn();
            assertThat(json.readTree(error.getResponse().getContentAsString())
                    .path("code").asText()).isEqualTo("VALIDATION_FAILED");
        }
        mvc.perform(get("/api/v1/dashboard/management")
                .principal(principal(manager)).param("from", FROM))
                .andExpect(status().isBadRequest());
        mvc.perform(get("/api/v1/dashboard/management")
                .principal(principal(manager)).param("from", "not-a-time").param("to", TO))
                .andExpect(status().isBadRequest());
        mvc.perform(get("/api/v1/dashboard/management")
                .principal(principal(manager)).param("from", FROM).param("to", TO)
                .param("orgUnitId", "not-a-uuid"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void signedJwtIsBoundToLiveSessionAndCurrentManagerRole() throws Exception {
        UUID u = unit();
        UserEntity manager = new UserEntity("de04-jwt-" + UUID.randomUUID()
                + "@example.invalid", "DE04 signed actor", GlobalRole.DEPARTMENT_MANAGER, null);
        manager.completeInitialSetup(passwordHasher.hash(
                "DE04 signed test account password 2026!"),
                OffsetDateTime.now(ZoneOffset.UTC));
        manager = userRepository.saveAndFlush(manager);
        grant(manager.getId(), u);
        var now = OffsetDateTime.now(ZoneOffset.UTC);
        AuthSessionEntity session = authSessions.saveAndFlush(
                new AuthSessionEntity(manager.getId(), AuthClientType.MOBILE,
                        now, now.plusDays(1), null));
        session.recordActivity(now);
        authSessions.saveAndFlush(session);
        String token = jwtTokens.issue(manager.getId(), session.getId());

        var good = mvc.perform(get("/api/v1/dashboard/management")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                .param("from", FROM).param("to", TO))
                .andExpect(status().isOk()).andReturn();
        assertThat(data(good).path("actionItems").path("totalOfficial").asLong()).isZero();

        jdbc.update("UPDATE users SET global_role='EMPLOYEE' WHERE id=?", manager.getId());
        mvc.perform(get("/api/v1/dashboard/management")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                .param("from", FROM).param("to", TO)).andExpect(status().isForbidden());

        jdbc.update("UPDATE users SET global_role='DEPARTMENT_MANAGER' WHERE id=?", manager.getId());
        session.revoke(OffsetDateTime.now(ZoneOffset.UTC), "LOGOUT");
        authSessions.saveAndFlush(session);
        mvc.perform(get("/api/v1/dashboard/management")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                .param("from", FROM).param("to", TO)).andExpect(status().isUnauthorized());
    }

    private Request request(UUID actor, String from, String to, UUID unitId) {
        return new Request(actor, from, to, unitId);
    }

    private final class Request {
        private final UUID actor, unitId;
        private final String from, to;
        Request(UUID actor, String from, String to, UUID unitId) {
            this.actor = actor; this.from = from; this.to = to; this.unitId = unitId;
        }
        MvcResult get() throws Exception {
            var request = org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                    .get("/api/v1/dashboard/management")
                    .principal(principal(actor)).param("from", from).param("to", to);
            if (unitId != null) request.param("orgUnitId", unitId.toString());
            return mvc.perform(request).andExpect(status().isOk()).andReturn();
        }
    }

    private JsonNode data(MvcResult r) throws Exception {
        return json.readTree(r.getResponse().getContentAsString()).path("data");
    }

    private static Principal principal(UUID actor) {
        return () -> actor.toString();
    }

    private static List<UUID> ids(JsonNode array) {
        var ids = new ArrayList<UUID>();
        for (JsonNode value : array) ids.add(UUID.fromString(value.asText()));
        return ids;
    }

    private UUID user(String role) {
        UUID id = UUID.randomUUID();
        String email = "de04-" + id + "@example.invalid";
        jdbc.update("""
            INSERT INTO users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'DE04 actor','test-only',?,'ACTIVE')
            """, id, email, email, role);
        return id;
    }

    private UUID unit() {
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO organizational_units(id,code,name,status) VALUES (?,?,?,'ACTIVE')",
                id, "DE04-" + id, "DE04 Unit");
        return id;
    }

    private void grant(UUID manager, UUID unitId) {
        jdbc.update("INSERT INTO manager_scope_units(user_id,org_unit_id) VALUES (?,?)",
                manager, unitId);
    }

    private UUID meeting(UUID organizer, UUID unitId) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id,status)
            VALUES (?,?,?,?,'DRAFT')
            """, id, "Protected meeting DE04 " + id, organizer, organizer);
        if (unitId != null) {
            jdbc.update("""
                INSERT INTO meeting_action_item_scopes(meeting_id,org_unit_id,recorded_by_user_id)
                VALUES (?,?,?)
                """, id, unitId, organizer);
        }
        return id;
    }

    private UUID action(UUID meetingId, UUID creator, UUID assignee, String state,
            LocalDate due, OffsetDateTime createdAt) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO action_items(id,meeting_id,title,status,assignee_user_id,due_date,
                source_type,created_by_user_id,created_at)
            VALUES (?,?,'DE04 official work','OPEN',?,?,'MANUAL',?,?)
            """, id, meetingId, assignee, due, creator, createdAt);
        switch (state) {
            case "OPEN" -> { }
            case "IN_PROGRESS" -> jdbc.update("""
                UPDATE action_items SET status='IN_PROGRESS',version=version+1 WHERE id=?
                """, id);
            case "DONE" -> jdbc.update("""
                UPDATE action_items SET status='DONE', completed_by_user_id=?,
                       completed_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=?
                """, assignee, id);
            case "CANCELLED" -> jdbc.update("""
                UPDATE action_items SET status='CANCELLED',cancelled_by_user_id=?,
                       cancelled_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=?
                """, creator, id);
            default -> throw new IllegalArgumentException(state);
        }
        return id;
    }

    private static OffsetDateTime at(String iso) {
        return OffsetDateTime.parse(iso);
    }
}
