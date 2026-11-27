package com.sme.meetingassistant.api.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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

/**
 * DB-MIG-003/008: simulate a real earlier canonical schema with a persisted
 * account before updating through PR3/P4 migrations. No Flyway.repair,
 * baselineOnMigrate, outOfOrder or retroactive migration edits are used.
 * Temporary dedicated PostgreSQL schema is always dropped after the test.
 */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class CanonicalFlywayUpgradeIntegrationTests {
    @Autowired DataSource dataSource;
    @Autowired JdbcTemplate jdbc;

    @Test
    void v1PersistedIdentityUpgradesThroughV22WithoutChangingHistoryOrData() {
        String schema="t06_upgrade_"+UUID.randomUUID().toString().replace("-","");
        try {
            Flyway initial=Flyway.configure()
                .dataSource(dataSource)
                .schemas(schema)
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("1"))
                .load();
            initial.migrate();

            UUID id=UUID.randomUUID();
            jdbc.update("""
                INSERT INTO %s.users
                  (id,email,email_normalized,display_name,global_role,account_status)
                  VALUES (?,?,?,?,'EMPLOYEE','PENDING_SETUP')
                """.formatted(schema),id,
                "upgrade-"+id+"@example.invalid","upgrade-"+id+"@example.invalid","Legacy User");

            Integer originalChecksum=jdbc.queryForObject("""
                SELECT checksum FROM %s.flyway_schema_history WHERE version='1'
                """.formatted(schema),Integer.class);
            assertThat(originalChecksum).isNotNull();

            Flyway upgraded=Flyway.configure()
                .dataSource(dataSource)
                .schemas(schema)
                .locations("classpath:db/migration")
                .load();
            upgraded.migrate();
            upgraded.validate();

            List<String> versions=jdbc.queryForList("""
                SELECT version FROM %s.flyway_schema_history
                WHERE success AND version IS NOT NULL ORDER BY installed_rank
                """.formatted(schema),String.class);
            assertThat(versions).startsWith("1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22");
            assertThat(jdbc.queryForObject("""
                SELECT checksum FROM %s.flyway_schema_history WHERE version='1'
                """.formatted(schema),Integer.class)).isEqualTo(originalChecksum);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.users
                WHERE id=? AND account_status='PENDING_SETUP' AND password_hash IS NULL
                """.formatted(schema),Integer.class,id)).isEqualTo(1);
            for(String table:List.of("email_deliveries","auth_sessions",
                    "password_reset_tokens","audit_events","auth_abuse_attempts","rooms","meetings","meeting_participants","room_reservations")) {
                Integer count=jdbc.queryForObject("""
                    SELECT count(*) FROM information_schema.tables
                    WHERE table_schema=? AND table_name=?
                    """,Integer.class,schema,table);
                assertThat(count).describedAs("Expected canonical upgrade table "+table).isEqualTo(1);
            }
            assertThat(jdbc.queryForObject(
                "SELECT to_regclass(?) IS NULL",Boolean.class,schema+".user_accounts")).isTrue();
        } finally {
            // Random server-side identifier with a fixed prefix and hex UUID;
            // safe for this test-only DDL. Does not touch application public schema.
            jdbc.execute("DROP SCHEMA IF EXISTS "+schema+" CASCADE");
        }
    }

    @Test
    void v7HistoricalUnavailableOutcomesUpgradeToSkippedWithoutHidingSmtpFailures() {
        String schema = "t07_upgrade_" + UUID.randomUUID().toString().replace("-", "");
        try {
            Flyway before = Flyway.configure()
                .dataSource(dataSource)
                .schemas(schema)
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("7"))
                .load();
            before.migrate();

            UUID unavailable = UUID.randomUUID();
            UUID exhausted = UUID.randomUUID();
            jdbc.update("""
                INSERT INTO %s.email_deliveries
                    (id,notification_type,recipient_email,status,dedupe_key,last_error_code,
                     created_at,updated_at)
                VALUES (?,'MEETING_SCHEDULED','user@example.invalid','DEAD',?,
                        'DELIVERY_ACTION_UNAVAILABLE',clock_timestamp(),clock_timestamp())
                """.formatted(schema), unavailable, "t07:" + unavailable);
            jdbc.update("""
                INSERT INTO %s.email_deliveries
                    (id,notification_type,recipient_email,status,dedupe_key,last_error_code,
                     created_at,updated_at)
                VALUES (?,'MEETING_SCHEDULED','user@example.invalid','DEAD',?,
                        'SMTP_DELIVERY_FAILED',clock_timestamp(),clock_timestamp())
                """.formatted(schema), exhausted, "t07:" + exhausted);

            Flyway upgraded = Flyway.configure()
                .dataSource(dataSource)
                .schemas(schema)
                .locations("classpath:db/migration")
                .load();
            upgraded.migrate();
            upgraded.validate();

            assertThat(jdbc.queryForObject("""
                SELECT status FROM %s.email_deliveries WHERE id=?
                """.formatted(schema), String.class, unavailable)).isEqualTo("SKIPPED");
            assertThat(jdbc.queryForObject("""
                SELECT skip_reason FROM %s.email_deliveries WHERE id=?
                """.formatted(schema), String.class, unavailable))
                    .isEqualTo("ACTION_NO_LONGER_ELIGIBLE");
            assertThat(jdbc.queryForObject("""
                SELECT last_error_code FROM %s.email_deliveries WHERE id=?
                """.formatted(schema), String.class, unavailable)).isNull();
            assertThat(jdbc.queryForObject("""
                SELECT status FROM %s.email_deliveries WHERE id=?
                """.formatted(schema), String.class, exhausted)).isEqualTo("DEAD");
            assertThat(jdbc.queryForObject("""
                SELECT last_error_code FROM %s.email_deliveries WHERE id=?
                """.formatted(schema), String.class, exhausted)).isEqualTo("SMTP_DELIVERY_FAILED");

            assertThatThrownBy(() -> jdbc.update("""
                UPDATE %s.email_deliveries
                   SET status='SKIPPED',skip_reason=NULL WHERE id=?
                """.formatted(schema), exhausted))
                .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
        } finally {
            jdbc.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
    }

    @Test
    void populatedV66UpgradesToV67WithoutChangingHistoryAndFencesCreationIntent() {
        String schema = "w6_upgrade_" + UUID.randomUUID().toString().replace("-", "");
        try {
            Flyway before = Flyway.configure().dataSource(dataSource).schemas(schema)
                .locations("classpath:db/migration").target(MigrationVersion.fromVersion("66")).load();
            assertThat(before.migrate().migrationsExecuted).isEqualTo(66);
            var history = jdbc.queryForList("SELECT version,checksum FROM " + schema
                + ".flyway_schema_history WHERE success AND version IS NOT NULL ORDER BY installed_rank");
            assertThat(history).hasSize(66);
            UUID owner = UUID.randomUUID(), other = UUID.randomUUID(), meeting = UUID.randomUUID();
            UUID conversation = UUID.randomUUID(), question = UUID.randomUUID();
            UUID answer = UUID.randomUUID(), turn = UUID.randomUUID();
            for (UUID user : List.of(owner, other)) {
                String email = "w6-" + user + "@example.invalid";
                jdbc.update("INSERT INTO " + schema
                    + ".users(id,email,email_normalized,display_name,password_hash,global_role,account_status)"
                    + " VALUES(?,?,?,'Upgrade fixture','test-only','EMPLOYEE','ACTIVE')", user, email, email);
            }
            jdbc.update("INSERT INTO " + schema
                + ".meetings(id,title,organizer_user_id,created_by_user_id,status)"
                + " VALUES(?,'Upgrade fixture',?,?,'DRAFT')", meeting, owner, owner);
            jdbc.update("INSERT INTO " + schema
                + ".assistant_conversations(id,user_id,meeting_id,title) VALUES(?,?,?,'Legacy conversation')",
                conversation, owner, meeting);
            jdbc.update("INSERT INTO " + schema
                + ".assistant_messages(id,conversation_id,role,content) VALUES(?,?,'USER','Legacy question')",
                question, conversation);
            jdbc.update("INSERT INTO " + schema
                + ".assistant_messages(id,conversation_id,role,content,answer_status)"
                + " VALUES(?,?,'ASSISTANT','Legacy answer','GROUNDED')", answer, conversation);
            jdbc.update("INSERT INTO " + schema
                + ".assistant_turns(id,conversation_id,idempotency_key,request_sha256,user_message_id,"
                + "assistant_message_id,state,scope_version) VALUES(?,?,?,?,?,?,'COMPLETED','v1')",
                turn, conversation, "legacy-key", "a".repeat(64), question, answer);

            Flyway after = Flyway.configure().dataSource(dataSource).schemas(schema)
                .locations("classpath:db/migration").load();
            assertThat(after.migrate().migrationsExecuted).isEqualTo(1);
            after.validate();
            assertThat(after.info().current().getVersion().getVersion()).isEqualTo("67");
            var upgradedHistory = jdbc.queryForList("SELECT version,checksum FROM " + schema
                + ".flyway_schema_history WHERE success AND version IS NOT NULL ORDER BY installed_rank");
            assertThat(upgradedHistory).hasSize(67);
            assertThat(upgradedHistory.subList(0, 66)).isEqualTo(history);
            assertThat(jdbc.queryForObject("SELECT count(*) FROM " + schema
                + ".assistant_conversations WHERE id=? AND user_id=? AND meeting_id=?"
                + " AND creation_key_digest IS NULL AND creation_request_digest IS NULL",
                Integer.class, conversation, owner, meeting)).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT content FROM " + schema
                + ".assistant_messages WHERE id=?", String.class, answer)).isEqualTo("Legacy answer");
            assertThat(jdbc.queryForObject("SELECT count(*) FROM " + schema
                + ".assistant_turns WHERE id=? AND user_message_id=? AND assistant_message_id=?"
                + " AND state='COMPLETED'", Integer.class, turn, question, answer)).isEqualTo(1);
            String insert = "INSERT INTO " + schema
                + ".assistant_conversations(id,user_id,meeting_id,creation_key_digest,creation_request_digest)"
                + " VALUES(?,?,?,?,?)";
            jdbc.update(insert, UUID.randomUUID(), owner, meeting, "b".repeat(64), "c".repeat(64));
            assertThatThrownBy(() -> jdbc.update(insert, UUID.randomUUID(), owner, meeting,
                "b".repeat(64), "d".repeat(64)))
                .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
            jdbc.update(insert, UUID.randomUUID(), other, meeting, "b".repeat(64), "c".repeat(64));
            assertThatThrownBy(() -> jdbc.update(insert, UUID.randomUUID(), owner, meeting,
                "e".repeat(64), null))
                .isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
        } finally {
            jdbc.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
    }

}
