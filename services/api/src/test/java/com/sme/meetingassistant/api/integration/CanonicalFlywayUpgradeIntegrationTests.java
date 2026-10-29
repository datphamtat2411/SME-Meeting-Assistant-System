package com.sme.meetingassistant.api.integration;

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
    void v1PersistedIdentityUpgradesThroughV5WithoutChangingHistoryOrData() {
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
            assertThat(versions).containsExactly("1","2","3","4","5","6","7");
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
}
