package com.sme.meetingassistant.api.notification;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.entity.AccountStatus;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Transactional;

/** AI-08.1 recovery smoke: GET is genuinely read-only and defaults need no user row. */
@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
@Transactional
class NotificationRecoveryIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired UserRepository users;

    @Test
    void newAccountReadsDefaultsWithoutCreatingPreferencesRow() throws Exception {
        UserEntity user = new UserEntity("ai08-recovery-" + UUID.randomUUID() + "@example.com",
                "Preferences recovery smoke", GlobalRole.EMPLOYEE, null);
        ReflectionTestUtils.setField(user, "passwordHash", "fixture-not-a-production-password");
        ReflectionTestUtils.setField(user, "accountStatus", AccountStatus.ACTIVE);
        users.saveAndFlush(user);

        var response = mvc.perform(get("/api/v1/me/preferences")
                .principal(() -> user.getId().toString()))
            .andExpect(status().isOk())
            .andReturn().getResponse().getContentAsString();

        assertThat(response).contains("\"meetingEmailEnabled\":true",
                "\"actionItemEmailEnabled\":true");
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM user_preferences WHERE user_id=?", Integer.class, user.getId()))
            .isZero();
    }
}
