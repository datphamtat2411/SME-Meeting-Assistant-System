package com.sme.meetingassistant.api.notification;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

/** AI-08.3: forward-only V32 to V33 upgrade preserves real historical Action Items. */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class ActionItemAssignmentFlywayUpgradeIntegrationTests {
    @Autowired DataSource dataSource;
    @Autowired JdbcTemplate jdbc;

    @Test
    void existingManualItemAndHistorySurviveAdditionOfImmutableEventSchema() {
        String schema = "ai08_events_" + UUID.randomUUID().toString().replace("-", "");
        try {
            Flyway before = Flyway.configure()
                    .dataSource(dataSource).schemas(schema)
                    .locations("classpath:db/migration")
                    .target(MigrationVersion.fromVersion("32")).load();
            before.migrate();
            before.validate();

            UUID actor = UUID.randomUUID(), meeting = UUID.randomUUID();
            UUID item = UUID.randomUUID(), history = UUID.randomUUID();
            String email = "ai08-upgrade-" + actor + "@example.invalid";
            jdbc.update("""
                INSERT INTO %s.users(id,email,email_normalized,display_name,password_hash,
                    global_role,account_status)
                VALUES (?,?,?,'Preserved actor','test-only','EMPLOYEE','ACTIVE')
                """.formatted(schema), actor, email, email);
            jdbc.update("""
                INSERT INTO %s.meetings(id,title,organizer_user_id,created_by_user_id)
                VALUES (?,'Existing assignment meeting',?,?)
                """.formatted(schema), meeting, actor, actor);
            jdbc.update("""
                INSERT INTO %s.action_items(id,meeting_id,title,status,assignee_user_id,
                    source_type,created_by_user_id)
                VALUES (?,?,'Historical manual action','OPEN',?,'MANUAL',?)
                """.formatted(schema), item, meeting, actor, actor);
            jdbc.update("""
                INSERT INTO %s.action_item_history
                    (id,action_item_id,change_type,from_value,to_value,changed_by_user_id)
                VALUES (?,?,'ASSIGNEE',NULL,?,?)
                """.formatted(schema), history, item, actor.toString(), actor);
            Integer historical = jdbc.queryForObject("""
                SELECT checksum FROM %s.flyway_schema_history WHERE version='32'
                """.formatted(schema), Integer.class);

            Flyway upgraded = Flyway.configure()
                    .dataSource(dataSource).schemas(schema)
                    .locations("classpath:db/migration").load();
            upgraded.migrate();
            upgraded.validate();

            assertThat(jdbc.queryForObject("""
                SELECT checksum FROM %s.flyway_schema_history WHERE version='32'
                """.formatted(schema), Integer.class)).isEqualTo(historical);
            assertThat(jdbc.queryForObject("""
                SELECT version FROM %s.flyway_schema_history WHERE success
                ORDER BY installed_rank DESC LIMIT 1
                """.formatted(schema), String.class)).isEqualTo("33");
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.action_items WHERE id=? AND assignee_user_id=?
                """.formatted(schema), Integer.class, item, actor)).isEqualTo(1);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.action_item_history WHERE id=? AND action_item_id=?
                """.formatted(schema), Integer.class, history, item)).isEqualTo(1);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.action_item_assignment_events WHERE action_item_id=?
                """.formatted(schema), Integer.class, item)).isZero();
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM information_schema.columns
                 WHERE table_schema=? AND table_name='action_item_assignment_events'
                   AND column_name IN ('id','action_item_id','action_item_version',
                       'history_id','assignee_user_id','event_type','created_at')
                """, Integer.class, schema)).isEqualTo(7);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_trigger trig
                 JOIN pg_class tab ON tab.oid=trig.tgrelid
                 JOIN pg_namespace ns ON ns.oid=tab.relnamespace
                 WHERE ns.nspname=? AND tab.relname='action_item_assignment_events'
                   AND trig.tgname='trg_ai_assignment_event_immutable' AND NOT trig.tgisinternal
                """, Integer.class, schema)).isEqualTo(1);
        } finally {
            jdbc.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
    }
}
