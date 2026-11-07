package com.sme.meetingassistant.api.actionitems;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.util.List;
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

/** AI-02/AI-04: V28 and V29 histories upgrade through V30 without rewriting prior checksums. */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class ActionItemFlywayUpgradeIntegrationTests {
    @Autowired DataSource dataSource;
    @Autowired JdbcTemplate jdbc;

    @Test
    void persistedV28MeetingIntelligenceDataUpgradesThroughV30WithoutHistoryRewrites() {
        String schema = "ai02_upgrade_" + UUID.randomUUID().toString().replace("-", "");
        try {
            Flyway previous = Flyway.configure()
                .dataSource(dataSource)
                .schemas(schema)
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("28"))
                .load();
            previous.migrate();
            previous.validate();

            UUID user = UUID.randomUUID(), meeting = UUID.randomUUID();
            String email = "ai02-upgrade-" + user + "@example.invalid";
            jdbc.update("""
                INSERT INTO %s.users(id,email,email_normalized,display_name,password_hash,
                    global_role,account_status)
                VALUES (?,?,?,'Persisted V28 user','test-only','EMPLOYEE','ACTIVE')
                """.formatted(schema), user, email, email);
            jdbc.update("""
                INSERT INTO %s.meetings(id,title,organizer_user_id,created_by_user_id)
                VALUES (?,'Persisted V28 meeting',?,?)
                """.formatted(schema), meeting, user, user);

            Integer checksum23 = jdbc.queryForObject("""
                SELECT checksum FROM %s.flyway_schema_history WHERE version='23'
                """.formatted(schema), Integer.class);
            Integer checksum28 = jdbc.queryForObject("""
                SELECT checksum FROM %s.flyway_schema_history WHERE version='28'
                """.formatted(schema), Integer.class);

            Flyway upgraded = Flyway.configure()
                .dataSource(dataSource)
                .schemas(schema)
                .locations("classpath:db/migration")
                .load();
            upgraded.migrate();
            upgraded.validate();

            List<String> versions = jdbc.queryForList("""
                SELECT version FROM %s.flyway_schema_history
                WHERE success AND version IS NOT NULL ORDER BY installed_rank
                """.formatted(schema), String.class);
            assertThat(versions).hasSize(30);
            assertThat(versions.getLast()).isEqualTo("30");
            assertThat(versions.stream().distinct().count()).isEqualTo(30);
            assertThat(jdbc.queryForObject("""
                SELECT checksum FROM %s.flyway_schema_history WHERE version='23'
                """.formatted(schema), Integer.class)).isEqualTo(checksum23);
            assertThat(jdbc.queryForObject("""
                SELECT checksum FROM %s.flyway_schema_history WHERE version='28'
                """.formatted(schema), Integer.class)).isEqualTo(checksum28);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.meetings WHERE id=? AND organizer_user_id=?
                """.formatted(schema), Integer.class, meeting, user)).isEqualTo(1);
            for (String table : List.of(
                    "meeting_intelligence_source_snapshots", "action_item_batch_receipts",
                    "action_items", "action_item_evidence", "action_item_history",
                    "meeting_action_item_scopes")) {
                assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM information_schema.tables
                    WHERE table_schema=? AND table_name=?
                    """, Integer.class, schema, table))
                    .describedAs("Expected preserved/new schema table " + table).isEqualTo(1);
            }
        } finally {
            jdbc.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
    }

    @Test
    void persistedV29ActionItemSurvivesV30AndLegacyMeetingIsNotAutoClassified() {
        String schema = "ai04_upgrade_" + UUID.randomUUID().toString().replace("-", "");
        try {
            Flyway old = Flyway.configure()
                .dataSource(dataSource).schemas(schema).locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("29")).load();
            old.migrate();
            old.validate();

            UUID actor = UUID.randomUUID(), meeting = UUID.randomUUID();
            UUID unit = UUID.randomUUID(), item = UUID.randomUUID();
            String email = "ai04-upgrade-" + actor + "@example.invalid";
            jdbc.update("""
                INSERT INTO %s.organizational_units(id,code,name,status)
                VALUES (?,?,'Historical unit','ACTIVE')
                """.formatted(schema), unit, "AI04-" + unit);
            jdbc.update("""
                INSERT INTO %s.users(id,email,email_normalized,display_name,password_hash,
                    global_role,account_status,primary_org_unit_id)
                VALUES (?,?,?,'Historical organizer','test-only','EMPLOYEE','ACTIVE',?)
                """.formatted(schema), actor,email,email,unit);
            jdbc.update("""
                INSERT INTO %s.meetings(id,title,organizer_user_id,created_by_user_id)
                VALUES (?,'Historical meeting',?,?)
                """.formatted(schema), meeting,actor,actor);
            jdbc.update("""
                INSERT INTO %s.action_items(id,meeting_id,title,status,source_type,
                    assignee_user_id,created_by_user_id)
                VALUES (?,?,'Existing task','OPEN','MANUAL',?,?)
                """.formatted(schema), item,meeting,actor,actor);
            Integer checksum29 = jdbc.queryForObject("""
                SELECT checksum FROM %s.flyway_schema_history WHERE version='29'
                """.formatted(schema),Integer.class);

            Flyway upgraded = Flyway.configure()
                .dataSource(dataSource).schemas(schema).locations("classpath:db/migration").load();
            upgraded.migrate();
            upgraded.validate();
            assertThat(jdbc.queryForObject("""
                SELECT checksum FROM %s.flyway_schema_history WHERE version='29'
                """.formatted(schema),Integer.class)).isEqualTo(checksum29);
            assertThat(jdbc.queryForObject("""
                SELECT title FROM %s.action_items WHERE id=?
                """.formatted(schema),String.class,item)).isEqualTo("Existing task");
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.meeting_action_item_scopes WHERE meeting_id=?
                """.formatted(schema),Integer.class,meeting)).isZero();
        } finally {
            jdbc.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
    }
}
