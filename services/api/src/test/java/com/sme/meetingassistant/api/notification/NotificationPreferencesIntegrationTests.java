package com.sme.meetingassistant.api.notification;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.notification.application.EmailNotificationPreferenceLookup;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.AccountStatus;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import java.security.Principal;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * AI-08.2: real PostgreSQL transactions and real HTTP PATCH semantics.
 * No enclosing test transaction: parallel requests must commit independently.
 */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class NotificationPreferencesIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired UserRepository users;
    @Autowired ObjectMapper mapper;
    @Autowired EmailNotificationPreferenceLookup lookup;

    @Test
    void getIsReadOnlySelfScopedAndDefaultsRequireNoRow() throws Exception {
        UserEntity first = activeUser();
        UserEntity second = activeUser();

        mvc.perform(get("/api/v1/me/preferences"))
                .andExpect(status().isUnauthorized());

        JsonNode defaults = read(first);
        assertThat(defaults.path("timezone").isNull()).isTrue();
        assertThat(defaults.path("locale").isNull()).isTrue();
        assertThat(defaults.path("meetingEmailEnabled").asBoolean()).isTrue();
        assertThat(defaults.path("actionItemEmailEnabled").asBoolean()).isTrue();
        assertThat(read(first)).isEqualTo(defaults);
        assertThat(countRows(first)).isZero();
        assertThat(countRows(second)).isZero();
        assertThat(lookup.meetingEmailEnabled(first.getId())).isTrue();
        assertThat(lookup.actionItemEmailEnabled(first.getId())).isTrue();
        assertThat(lookup.meetingEmailEnabled(null)).isFalse();

        patchSuccess(first, "{\"meetingEmailEnabled\":false}");
        assertThat(read(first).path("meetingEmailEnabled").asBoolean()).isFalse();
        assertThat(read(second).path("meetingEmailEnabled").asBoolean()).isTrue();
        assertThat(countRows(second)).isZero();
        assertThat(lookup.meetingEmailEnabled(first.getId())).isFalse();
        assertThat(lookup.actionItemEmailEnabled(first.getId())).isTrue();
    }

    @Test
    void omittedFieldsRemainUnchangedNullClearsOnlyOptionalStringsAndNoOpDoesNotWrite() throws Exception {
        UserEntity user = activeUser();
        JsonNode initial = patchSuccess(user, """
                {"timezone":"Asia/Ho_Chi_Minh","locale":"vi-VN",
                 "meetingEmailEnabled":false,"actionItemEmailEnabled":false}
                """);
        assertThat(initial.path("timezone").asText()).isEqualTo("Asia/Ho_Chi_Minh");
        assertThat(initial.path("locale").asText()).isEqualTo("vi-VN");

        OffsetDateTime before = changedAt(user);
        JsonNode noOp = patchSuccess(user, """
                {"locale":"vi-VN","meetingEmailEnabled":false}
                """);
        assertThat(noOp.path("actionItemEmailEnabled").asBoolean()).isFalse();
        assertThat(changedAt(user)).isEqualTo(before);

        JsonNode updated = patchSuccess(user, """
                {"timezone":null,"locale":null,"actionItemEmailEnabled":true}
                """);
        assertThat(updated.path("timezone").isNull()).isTrue();
        assertThat(updated.path("locale").isNull()).isTrue();
        assertThat(updated.path("meetingEmailEnabled").asBoolean()).isFalse();
        assertThat(updated.path("actionItemEmailEnabled").asBoolean()).isTrue();
        assertThat(countRows(user)).isEqualTo(1);
        assertThat(lookup.actionItemEmailEnabled(user.getId())).isTrue();
    }

    @Test
    void invalidPatchIsRejectedWithoutPersistentSideEffects() throws Exception {
        UserEntity user = activeUser();
        for (String body : new String[] {
                "{}", "[]", "42", "{\"unknown\":true}",
                "{\"meetingEmailEnabled\":null}", "{\"actionItemEmailEnabled\":1}",
                "{\"meetingEmailEnabled\":\"false\"}", "{\"timezone\":42}",
                "{\"timezone\":\"\"}", "{\"timezone\":\"Mars/Olympus\"}",
                "{\"locale\":true}", "{\"locale\":\"en-@\"}",
                "{\"locale\":\"und\"}", "{\"timezone\":{\"id\":\"UTC\"}}",
                "{\"meetingEmailEnabled\":false,\"unknown\":true}"
        }) {
            mvc.perform(patch("/api/v1/me/preferences")
                    .principal(principal(user))
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(body))
                .andExpect(status().isUnprocessableEntity());
            assertThat(countRows(user)).describedAs("invalid body: " + body).isZero();
        }

        patchSuccess(user, "{\"actionItemEmailEnabled\":false}");
        OffsetDateTime before = changedAt(user);
        mvc.perform(patch("/api/v1/me/preferences")
                .principal(principal(user))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"timezone\":\"Asia/Ho_Chi_Minh\",\"locale\":\"en-@\"}"))
            .andExpect(status().isUnprocessableEntity());
        assertThat(changedAt(user)).isEqualTo(before);
        assertThat(read(user).path("actionItemEmailEnabled").asBoolean()).isFalse();
    }

    @Test
    void concurrentDisjointPatchesPreserveBothFieldsOnFirstRowCreation() throws Exception {
        UserEntity user = activeUser();
        assertThat(countRows(user)).isZero();
        var ready = new CountDownLatch(2);
        var start = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var first = pool.submit(() -> {
                ready.countDown();
                if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("start timeout");
                patchSuccess(user, "{\"meetingEmailEnabled\":false}");
                return true;
            });
            var second = pool.submit(() -> {
                ready.countDown();
                if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("start timeout");
                patchSuccess(user, "{\"locale\":\"vi-VN\",\"actionItemEmailEnabled\":false}");
                return true;
            });
            assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            assertThat(first.get(30, TimeUnit.SECONDS)).isTrue();
            assertThat(second.get(30, TimeUnit.SECONDS)).isTrue();
        }
        JsonNode finalState = read(user);
        assertThat(countRows(user)).isEqualTo(1);
        assertThat(finalState.path("meetingEmailEnabled").asBoolean()).isFalse();
        assertThat(finalState.path("actionItemEmailEnabled").asBoolean()).isFalse();
        assertThat(finalState.path("locale").asText()).isEqualTo("vi-VN");
    }

    @Test
    void inactiveOrNonexistentPrincipalCannotReadOrPatchPreferences() throws Exception {
        UserEntity user = activeUser();
        user.deactivate(OffsetDateTime.now(ZoneOffset.UTC));
        users.saveAndFlush(user);
        mvc.perform(get("/api/v1/me/preferences").principal(principal(user)))
                .andExpect(status().isUnauthorized());
        mvc.perform(patch("/api/v1/me/preferences")
                .principal(principal(user))
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"meetingEmailEnabled\":false}"))
            .andExpect(status().isUnauthorized());
        mvc.perform(get("/api/v1/me/preferences")
                .principal(() -> UUID.randomUUID().toString()))
            .andExpect(status().isUnauthorized());
        assertThat(countRows(user)).isZero();
    }

    private UserEntity activeUser() {
        UserEntity user = new UserEntity("prefs-" + UUID.randomUUID() + "@example.invalid",
                "Notification preferences integration", GlobalRole.EMPLOYEE, null);
        ReflectionTestUtils.setField(user, "passwordHash", "fixture-not-a-production-password");
        ReflectionTestUtils.setField(user, "accountStatus", AccountStatus.ACTIVE);
        return users.saveAndFlush(user);
    }

    private static Principal principal(UserEntity user) {
        return () -> user.getId().toString();
    }

    private JsonNode read(UserEntity user) throws Exception {
        return mapper.readTree(mvc.perform(get("/api/v1/me/preferences")
                .principal(principal(user)))
            .andExpect(status().isOk()).andReturn()
            .getResponse().getContentAsString()).path("data");
    }

    private JsonNode patchSuccess(UserEntity user, String payload) throws Exception {
        return mapper.readTree(mvc.perform(patch("/api/v1/me/preferences")
                .principal(principal(user))
                .contentType(MediaType.APPLICATION_JSON)
                .content(payload))
            .andExpect(status().isOk()).andReturn()
            .getResponse().getContentAsString()).path("data");
    }

    private int countRows(UserEntity user) {
        return jdbc.queryForObject("SELECT count(*) FROM user_preferences WHERE user_id=?",
                Integer.class, user.getId());
    }

    private OffsetDateTime changedAt(UserEntity user) {
        return jdbc.queryForObject("SELECT updated_at FROM user_preferences WHERE user_id=?",
                OffsetDateTime.class, user.getId());
    }
}
