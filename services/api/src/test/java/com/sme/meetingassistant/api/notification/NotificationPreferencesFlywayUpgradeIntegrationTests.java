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

/** AI-08.2/08.3: V31 canonical data upgrades through V32 and V33 without rewriting history. */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class NotificationPreferencesFlywayUpgradeIntegrationTests {
    @Autowired DataSource dataSource;
    @Autowired JdbcTemplate jdbc;

    @Test
    void existingAccountAndFlywayChecksumsSurviveV31ToV33() {
        String schema = "ai08_pref_" + UUID.randomUUID().toString().replace("-", "");
        try {
            Flyway before = Flyway.configure()
                    .dataSource(dataSource).schemas(schema)
                    .locations("classpath:db/migration")
                    .target(MigrationVersion.fromVersion("31"))
                    .load();
            before.migrate();
            before.validate();

            UUID userId = UUID.randomUUID();
            String email = "ai08-pref-upgrade-" + userId + "@example.invalid";
            jdbc.update("""
                INSERT INTO %s.users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
                VALUES (?,?,?,'Preserved account','test-only','EMPLOYEE','ACTIVE')
                """.formatted(schema), userId, email, email);
            Integer previousChecksum = jdbc.queryForObject("""
                SELECT checksum FROM %s.flyway_schema_history WHERE version='31'
                """.formatted(schema), Integer.class);
            assertThat(previousChecksum).isNotNull();

            Flyway current = Flyway.configure()
                    .dataSource(dataSource).schemas(schema)
                    .locations("classpath:db/migration").load();
            current.migrate();
            current.validate();

            assertThat(jdbc.queryForObject("""
                SELECT checksum FROM %s.flyway_schema_history WHERE version='31'
                """.formatted(schema), Integer.class)).isEqualTo(previousChecksum);
            assertThat(jdbc.queryForObject("""
                SELECT version FROM %s.flyway_schema_history
                 WHERE success ORDER BY installed_rank DESC LIMIT 1
                """.formatted(schema), String.class)).isEqualTo("33");
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.users WHERE id=? AND email_normalized=?
                """.formatted(schema), Integer.class, userId, email)).isEqualTo(1);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM information_schema.columns
                 WHERE table_schema=? AND table_name='user_preferences'
                   AND column_name IN ('user_id','timezone','locale',
                    'meeting_email_enabled','action_item_email_enabled','created_at','updated_at')
                """, Integer.class, schema)).isEqualTo(7);

            jdbc.update("INSERT INTO %s.user_preferences(user_id) VALUES (?)".formatted(schema), userId);
            assertThat(jdbc.queryForObject("""
                SELECT meeting_email_enabled AND action_item_email_enabled
                  FROM %s.user_preferences WHERE user_id=?
                """.formatted(schema), Boolean.class, userId)).isTrue();
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_constraint c
                JOIN pg_class t ON t.oid=c.conrelid
                JOIN pg_namespace n ON n.oid=t.relnamespace
                WHERE n.nspname=? AND t.relname='user_preferences' AND c.contype='f'
                """, Integer.class, schema)).isEqualTo(1);
        } finally {
            jdbc.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
    }
}
