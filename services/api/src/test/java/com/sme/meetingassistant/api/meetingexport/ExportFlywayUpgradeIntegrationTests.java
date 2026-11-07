package com.sme.meetingassistant.api.meetingexport;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
 * DE-06 forward-only upgrade: V34 production data remains intact while V35
 * adds export metadata and strict transition guards. No V1..V34 checksum
 * rewrite, no reclassification of old meetings and no synthetic export jobs.
 */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class ExportFlywayUpgradeIntegrationTests {
    @Autowired DataSource dataSource;
    @Autowired JdbcTemplate jdbc;

    @Test
    void existingV34DatabaseUpgradesToV35WithoutTouchingCanonicalDataOrChecksums() {
        String schema = "de06_upgrade_" + UUID.randomUUID().toString().replace("-", "");
        try {
            Flyway historical = Flyway.configure().dataSource(dataSource).schemas(schema)
                    .locations("classpath:db/migration")
                    .target(MigrationVersion.fromVersion("34")).load();
            historical.migrate();
            historical.validate();

            UUID organizer = UUID.randomUUID(), meeting = UUID.randomUUID();
            String email = "de06-upgrade-" + organizer + "@example.invalid";
            jdbc.update("""
                INSERT INTO %s.users(id,email,email_normalized,display_name,password_hash,
                    global_role,account_status)
                VALUES (?,?,?,'Upgrade fixture','test-only','EMPLOYEE','ACTIVE')
                """.formatted(schema), organizer, email, email);
            jdbc.update("""
                INSERT INTO %s.meetings(id,title,organizer_user_id,created_by_user_id)
                VALUES (?,'Historical canonical meeting',?,?)
                """.formatted(schema), meeting, organizer, organizer);

            Map<String, Integer> beforeChecksums = checksums(schema);
            assertThat(beforeChecksums).hasSize(34).containsKey("34");

            Flyway upgraded = Flyway.configure().dataSource(dataSource).schemas(schema)
                    .locations("classpath:db/migration").load();
            upgraded.migrate();
            upgraded.validate();

            Map<String, Integer> afterChecksums = checksums(schema);
            assertThat(afterChecksums).hasSize(35).containsKey("35");
            for (var entry : beforeChecksums.entrySet()) {
                assertThat(afterChecksums.get(entry.getKey()))
                        .describedAs("Historical Flyway migration checksum V" + entry.getKey())
                        .isEqualTo(entry.getValue());
            }
            assertThat(jdbc.queryForObject("""
                SELECT COUNT(*) FROM %s.meetings
                 WHERE id=? AND organizer_user_id=? AND title='Historical canonical meeting'
                """.formatted(schema), Long.class, meeting, organizer)).isEqualTo(1L);
            assertThat(jdbc.queryForObject("""
                SELECT COUNT(*) FROM %s.meeting_exports WHERE meeting_id=?
                """.formatted(schema), Long.class, meeting)).isZero();
            assertThat(jdbc.queryForObject("""
                SELECT COUNT(*) FROM information_schema.tables
                 WHERE table_schema=? AND table_name IN
                       ('meeting_exports','meeting_export_idempotency')
                """, Long.class, schema)).isEqualTo(2L);

            UUID exportId = UUID.randomUUID();
            jdbc.update("""
                INSERT INTO %s.meeting_exports(id,meeting_id,format,requested_by_user_id)
                VALUES (?,?, 'MARKDOWN',?)
                """.formatted(schema), exportId, meeting, organizer);
            assertThat(jdbc.queryForObject("""
                SELECT status FROM %s.meeting_exports WHERE id=?
                """.formatted(schema), String.class, exportId)).isEqualTo("PENDING");
        } finally {
            jdbc.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
    }

    private Map<String, Integer> checksums(String schema) {
        Map<String, Integer> result = new LinkedHashMap<>();
        jdbc.query("""
            SELECT version,checksum FROM %s.flyway_schema_history
             WHERE success AND version IS NOT NULL ORDER BY installed_rank
            """.formatted(schema), rs -> {
            result.put(rs.getString("version"), rs.getInt("checksum"));
        });
        return result;
    }
}
