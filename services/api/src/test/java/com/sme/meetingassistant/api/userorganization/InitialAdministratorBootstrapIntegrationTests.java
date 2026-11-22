package com.sme.meetingassistant.api.userorganization;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.userorganization.bootstrap.InitialAdministratorBootstrapService;
import com.sme.meetingassistant.api.userorganization.entity.AccountStatus;
import com.sme.meetingassistant.api.userorganization.entity.GlobalRole;
import com.sme.meetingassistant.api.userorganization.entity.UserEntity;
import com.sme.meetingassistant.api.userorganization.repository.UserRepository;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupService;
import com.sme.meetingassistant.api.userorganization.setup.AccountSetupTokenCodec;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.annotation.Transactional;

/** PostgreSQL-backed regression coverage for the command-only first-admin path. */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
@Transactional
class InitialAdministratorBootstrapIntegrationTests {
    @Autowired private InitialAdministratorBootstrapService bootstrap;
    @Autowired private AccountSetupService accountSetup;
    @Autowired private AccountSetupTokenCodec tokens;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private UserRepository users;

    @Test
    void issuesPendingAdministratorThroughExistingSetupFlowWithoutCredentials() {
        var result = bootstrap.request("initial-admin@example.com", "Initial Administrator");

        assertThat(result.status())
            .isEqualTo(InitialAdministratorBootstrapService.Status.ISSUED);
        UUID userId = result.userId();
        assertThat(jdbc.queryForObject(
            "SELECT global_role FROM users WHERE id=?", String.class, userId))
            .isEqualTo("ADMINISTRATOR");
        assertThat(jdbc.queryForObject(
            "SELECT account_status FROM users WHERE id=?", String.class, userId))
            .isEqualTo("PENDING_SETUP");
        assertThat(jdbc.queryForObject(
            "SELECT password_hash FROM users WHERE id=?", String.class, userId))
            .isNull();

        UUID tokenId = jdbc.queryForObject(
            "SELECT id FROM account_setup_tokens WHERE user_id=?", UUID.class, userId);
        assertThat(jdbc.queryForObject(
            "SELECT token_hash FROM account_setup_tokens WHERE id=?", String.class, tokenId))
            .isEqualTo(tokens.sha256(tokens.issue(tokenId)));
        assertThat(jdbc.queryForObject(
            "SELECT COUNT(*) FROM email_deliveries WHERE recipient_user_id=?",
            Integer.class, userId)).isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT state FROM initial_administrator_bootstrap WHERE id=1", String.class))
            .isEqualTo("ISSUED");
        assertThat(jdbc.queryForObject("""
            SELECT COUNT(*) FROM audit_events
             WHERE action_code='INITIAL_ADMIN_BOOTSTRAP_ISSUED' AND entity_id=?
            """, Integer.class, userId)).isEqualTo(1);
    }

    @Test
    void repeatedRequestDoesNotIssueAnotherAccountOrToken() {
        var first = bootstrap.request("repeat-admin@example.com", "Repeat Administrator");
        var second = bootstrap.request("different@example.com", "Different Administrator");

        assertThat(second.status())
            .isEqualTo(InitialAdministratorBootstrapService.Status.ALREADY_PENDING);
        assertThat(second.userId()).isEqualTo(first.userId());
        assertThat(jdbc.queryForObject(
            "SELECT COUNT(*) FROM users WHERE global_role='ADMINISTRATOR'",
            Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT COUNT(*) FROM account_setup_tokens WHERE user_id=?",
            Integer.class, first.userId())).isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT COUNT(*) FROM email_deliveries WHERE recipient_user_id=?",
            Integer.class, first.userId())).isEqualTo(1);
    }

    @Test
    void existingSetupCompletionMarksTheBootstrapIntentComplete() {
        var issued = bootstrap.request("complete-admin@example.com", "Complete Administrator");
        UUID tokenId = jdbc.queryForObject(
            "SELECT id FROM account_setup_tokens WHERE user_id=?",
            UUID.class, issued.userId());

        accountSetup.completeSetup(
            tokens.issue(tokenId), "A strong bootstrap password with 2026!");

        assertThat(jdbc.queryForObject(
            "SELECT account_status FROM users WHERE id=?", String.class, issued.userId()))
            .isEqualTo("ACTIVE");
        assertThat(jdbc.queryForObject(
            "SELECT state FROM initial_administrator_bootstrap WHERE id=1", String.class))
            .isEqualTo("COMPLETED");
        assertThat(jdbc.queryForObject(
            "SELECT completed_at FROM initial_administrator_bootstrap WHERE id=1",
            Object.class)).isNotNull();
    }

    @Test
    void refusesToRunWhenAnActiveAdministratorAlreadyExists() {
        UserEntity existing = new UserEntity(
            "existing-admin@example.com", "Existing Administrator",
            GlobalRole.ADMINISTRATOR, null);
        ReflectionTestUtils.setField(existing, "accountStatus", AccountStatus.ACTIVE);
        ReflectionTestUtils.setField(existing, "passwordHash", "$argon2id$existing");
        users.saveAndFlush(existing);

        var result = bootstrap.request("must-not-be-created@example.com", "Must Not Be Created");

        assertThat(result.status())
            .isEqualTo(InitialAdministratorBootstrapService.Status.ACTIVE_ADMIN_EXISTS);
        assertThat(jdbc.queryForObject(
            "SELECT COUNT(*) FROM users WHERE global_role='ADMINISTRATOR'",
            Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT state FROM initial_administrator_bootstrap WHERE id=1", String.class))
            .isEqualTo("AVAILABLE");
    }

    @Test
    void neverPromotesAnExistingOrganizer() {
        UserEntity organizer = new UserEntity(
            "organizer@example.com", "Existing Organizer", GlobalRole.EMPLOYEE, null);
        ReflectionTestUtils.setField(organizer, "accountStatus", AccountStatus.ACTIVE);
        ReflectionTestUtils.setField(organizer, "passwordHash", "$argon2id$existing");
        users.saveAndFlush(organizer);

        assertThatThrownBy(() -> bootstrap.request(
            "organizer@example.com", "Administrator Alias"))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("already exists");

        assertThat(jdbc.queryForObject(
            "SELECT global_role FROM users WHERE id=?", String.class, organizer.getId()))
            .isEqualTo("EMPLOYEE");
        assertThat(jdbc.queryForObject(
            "SELECT COUNT(*) FROM users WHERE global_role='ADMINISTRATOR'",
            Integer.class)).isZero();
    }
}
