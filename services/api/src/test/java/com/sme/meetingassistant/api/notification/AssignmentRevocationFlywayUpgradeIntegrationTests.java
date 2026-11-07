package com.sme.meetingassistant.api.notification;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.test.context.ActiveProfiles;

/**
 * AI-08.4: live historical V33 events survive V34 untouched.
 * Revocation requires the exact audited terminal transition and is immutable.
 */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class AssignmentRevocationFlywayUpgradeIntegrationTests {
    @Autowired DataSource dataSource;
    @Autowired JdbcTemplate jdbc;
    @Autowired PlatformTransactionManager transactionManager;

    @Test
    void v33EventSurvivesV34AndHistoricalTerminalStateIsProvablyRevocable() {
        String schema = "ai08_rev_" + UUID.randomUUID().toString().replace("-", "");
        try {
            Flyway before = Flyway.configure()
                .dataSource(dataSource).schemas(schema)
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("33")).load();
            before.migrate();
            before.validate();

            UUID user = UUID.randomUUID(), meeting = UUID.randomUUID();
            UUID item = UUID.randomUUID(), history = UUID.randomUUID();
            UUID event = UUID.randomUUID(), termination = UUID.randomUUID();
            String email = "ai08-revocation-" + user + "@example.invalid";
            jdbc.update("""
                INSERT INTO %s.users(id,email,email_normalized,display_name,password_hash,
                    global_role,account_status)
                VALUES (?,?,?,'V33 existing user','test-only','EMPLOYEE','ACTIVE')
                """.formatted(schema), user, email, email);
            jdbc.update("""
                INSERT INTO %s.meetings(id,title,organizer_user_id,created_by_user_id)
                VALUES (?,'V33 existing meeting',?,?)
                """.formatted(schema), meeting, user, user);
            jdbc.update("""
                INSERT INTO %s.action_items(id,meeting_id,title,status,assignee_user_id,
                    source_type,created_by_user_id)
                VALUES (?,?,'V33 existing action','OPEN',?,'MANUAL',?)
                """.formatted(schema), item, meeting, user, user);
            jdbc.update("""
                INSERT INTO %s.action_item_history
                    (id,action_item_id,change_type,from_value,to_value,changed_by_user_id)
                VALUES (?,?,'ASSIGNEE',NULL,?,?)
                """.formatted(schema), history, item, user.toString(), user);
            // At historical V33 the trigger uses the connection search_path.
            // Model the historical schema's real search_path for this pre-upgrade
            // insert; the new V34 replacement no longer depends on it.
            new TransactionTemplate(transactionManager).executeWithoutResult(tx -> {
                jdbc.execute("SET LOCAL search_path TO " + schema + ", public");
                jdbc.update("""
                    INSERT INTO %s.action_item_assignment_events
                        (id,action_item_id,action_item_version,history_id,assignee_user_id,event_type)
                    VALUES (?,?,0,?,?,'ASSIGNED')
                    """.formatted(schema), event, item, history, user);
            });
            Integer oldChecksum = jdbc.queryForObject("""
                SELECT checksum FROM %s.flyway_schema_history WHERE version='33'
                """.formatted(schema), Integer.class);

            Flyway upgraded = Flyway.configure().dataSource(dataSource).schemas(schema)
                .locations("classpath:db/migration").load();
            upgraded.migrate();
            upgraded.validate();

            assertThat(jdbc.queryForObject("""
                SELECT checksum FROM %s.flyway_schema_history WHERE version='33'
                """.formatted(schema), Integer.class)).isEqualTo(oldChecksum);
            assertThat(jdbc.queryForObject("""
                SELECT version FROM %s.flyway_schema_history WHERE success
                 ORDER BY installed_rank DESC LIMIT 1
                """.formatted(schema), String.class)).isEqualTo("34");
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.action_item_assignment_events WHERE id=?
                """.formatted(schema), Integer.class, event)).isEqualTo(1);

            // The V34 forward-only trigger repair works with qualified SQL
            // even when the caller does not change session search_path.
            UUID nextItem = UUID.randomUUID(), nextHistory = UUID.randomUUID();
            UUID nextEvent = UUID.randomUUID();
            jdbc.update("""
                INSERT INTO %s.action_items(id,meeting_id,title,status,assignee_user_id,
                    source_type,created_by_user_id)
                VALUES (?,?,'Post-upgrade assignment','OPEN',?,'MANUAL',?)
                """.formatted(schema), nextItem, meeting, user, user);
            jdbc.update("""
                INSERT INTO %s.action_item_history
                    (id,action_item_id,change_type,from_value,to_value,changed_by_user_id)
                VALUES (?,?,'ASSIGNEE',NULL,?,?)
                """.formatted(schema), nextHistory, nextItem, user.toString(), user);
            jdbc.update("""
                INSERT INTO %s.action_item_assignment_events
                    (id,action_item_id,action_item_version,history_id,assignee_user_id,event_type)
                VALUES (?,?,0,?,?,'ASSIGNED')
                """.formatted(schema), nextEvent, nextItem, nextHistory, user);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.action_item_assignment_events WHERE id=?
                """.formatted(schema), Integer.class, nextEvent)).isEqualTo(1);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.action_item_assignment_revocations WHERE event_id=?
                """.formatted(schema), Integer.class, event)).isZero();

            assertThatThrownBy(() -> jdbc.update("""
                INSERT INTO %s.action_item_assignment_revocations
                    (event_id,action_item_id,status_history_id,action_item_version,reason)
                VALUES (?,?,?,1,'DONE')
                """.formatted(schema), event, item, history))
                .isInstanceOf(DataIntegrityViolationException.class);

            jdbc.update("""
                UPDATE %s.action_items SET status='DONE',
                    completed_by_user_id=?,completed_at=clock_timestamp(),version=1
                WHERE id=?
                """.formatted(schema), user, item);
            jdbc.update("""
                INSERT INTO %s.action_item_history
                    (id,action_item_id,change_type,from_value,to_value,changed_by_user_id)
                VALUES (?,?,'STATUS','OPEN','DONE',?)
                """.formatted(schema), termination, item, user);
            jdbc.update("""
                INSERT INTO %s.action_item_assignment_revocations
                    (event_id,action_item_id,status_history_id,action_item_version,reason)
                VALUES (?,?,?,1,'DONE')
                """.formatted(schema), event, item, termination);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.action_item_assignment_revocations WHERE event_id=?
                """.formatted(schema), Integer.class, event)).isEqualTo(1);
            assertThatThrownBy(() -> jdbc.update("""
                UPDATE %s.action_item_assignment_revocations
                   SET reason='CANCELLED' WHERE event_id=?
                """.formatted(schema), event))
                .isInstanceOf(DataIntegrityViolationException.class);
            assertThatThrownBy(() -> jdbc.update("""
                DELETE FROM %s.action_item_assignment_revocations WHERE event_id=?
                """.formatted(schema), event))
                .isInstanceOf(DataIntegrityViolationException.class);
        } finally {
            jdbc.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
    }
}
