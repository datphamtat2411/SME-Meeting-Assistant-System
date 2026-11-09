package com.sme.meetingassistant.api.meetingexport;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

/**
 * DE-13: V34 historical canonical DB must advance through develop V35-V39
 * and Dashboard/Export V40-V45 without checksum rewrite, meeting loss or
 * silently mutable pinned export intake.
 */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class DashboardExportFullUpgradeIntegrationTests {
    @Autowired DataSource dataSource;
    @Autowired JdbcTemplate jdbc;

    @Test
    void v34ToV45PreservesAllHistoricalChecksumsAndCanonicalRows() {
        String schema = "de13_upgrade_" + UUID.randomUUID().toString().replace("-", "");
        try {
            Flyway older = Flyway.configure().dataSource(dataSource).schemas(schema)
                    .locations("classpath:db/migration")
                    .target(MigrationVersion.fromVersion("34")).load();
            older.migrate();
            older.validate();

            UUID owner=UUID.randomUUID(), meeting=UUID.randomUUID();
            String email="de13-upgrade-"+owner+"@example.invalid";
            jdbc.update("""
                INSERT INTO %s.users(id,email,email_normalized,display_name,password_hash,
                          global_role,account_status)
                VALUES (?,?,?,'DE13 history','test-only','EMPLOYEE','ACTIVE')
                """.formatted(schema), owner,email,email);
            jdbc.update("""
                INSERT INTO %s.meetings(id,title,organizer_user_id,created_by_user_id)
                VALUES (?,'DE13 canonical history',?,?)
                """.formatted(schema), meeting,owner,owner);

            Map<String,Integer> original=checksums(schema);
            assertThat(original).hasSize(34).containsKey("34");
            Flyway upgraded=Flyway.configure().dataSource(dataSource).schemas(schema)
                    .locations("classpath:db/migration").load();
            assertThat(upgraded.migrate().migrationsExecuted).isEqualTo(11);
            upgraded.validate();
            Map<String,Integer> current=checksums(schema);
            assertThat(current).hasSize(45).containsKeys(
                    "35","36","37","38","39","40","41","42","43","44","45");
            for(var item:original.entrySet()) {
                assertThat(current.get(item.getKey())).describedAs(
                    "V" + item.getKey() + " historical checksum")
                    .isEqualTo(item.getValue());
            }
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.meetings WHERE id=? AND organizer_user_id=?
                """.formatted(schema),Long.class,meeting,owner)).isEqualTo(1L);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM information_schema.tables
                 WHERE table_schema=? AND table_name IN (
                   'meeting_exports','meeting_export_idempotency',
                   'meeting_export_intakes','meeting_export_reconciliation_cursor',
                   'meeting_export_orphan_candidates')
                """,Long.class,schema)).isEqualTo(5L);

            UUID export=UUID.randomUUID();
            jdbc.update("""
                INSERT INTO %s.meeting_exports(id,meeting_id,format,requested_by_user_id)
                VALUES (?,?, 'MARKDOWN',?)
                """.formatted(schema),export,meeting,owner);
            String sourceHash="a".repeat(64),intakeHash="b".repeat(64);
            String key="exports/"+export+"/intake/"+intakeHash+".json";
            jdbc.update("""
                INSERT INTO %s.meeting_export_intakes(export_id,meeting_id,
                  requested_by_user_id,source_fingerprint,intake_sha256,object_key)
                VALUES (?,?,?,?,?,?)
                """.formatted(schema),export,meeting,owner,sourceHash,intakeHash,key);
            assertThatThrownBy(() -> jdbc.update("""
                UPDATE %s.meeting_export_intakes SET source_fingerprint=? WHERE export_id=?
                """.formatted(schema),"c".repeat(64),export))
                .isInstanceOf(DataAccessException.class);
            assertThat(jdbc.queryForObject("""
                SELECT source_fingerprint FROM %s.meeting_export_intakes WHERE export_id=?
                """.formatted(schema),String.class,export)).isEqualTo(sourceHash);
        } finally {
            jdbc.execute("DROP SCHEMA IF EXISTS "+schema+" CASCADE");
        }
    }


    @Test
    void populatedDevelopV39UpgradesThroughV45WithUnchangedHistoricalChecksums() {
        String schema = "de13_develop_upgrade_" + UUID.randomUUID().toString().replace("-", "");
        try {
            Flyway developHistory = Flyway.configure().dataSource(dataSource).schemas(schema)
                    .locations("classpath:db/migration")
                    .target(MigrationVersion.fromVersion("39")).load();
            assertThat(developHistory.migrate().migrationsExecuted).isEqualTo(39);
            developHistory.validate();

            UUID owner = UUID.randomUUID(), meeting = UUID.randomUUID();
            String email = "de13-develop-" + owner + "@example.invalid";
            jdbc.update("""
                INSERT INTO %s.users(id,email,email_normalized,display_name,password_hash,
                          global_role,account_status)
                VALUES (?,?,?,'Develop V39 baseline','test-only','EMPLOYEE','ACTIVE')
                """.formatted(schema), owner, email, email);
            jdbc.update("""
                INSERT INTO %s.meetings(id,title,organizer_user_id,created_by_user_id)
                VALUES (?,'Preserved before export migrations',?,?)
                """.formatted(schema), meeting, owner, owner);

            Map<String, Integer> before = checksums(schema);
            assertThat(before).hasSize(39).containsKeys("35", "36", "37", "38", "39");
            Flyway integrated = Flyway.configure().dataSource(dataSource).schemas(schema)
                    .locations("classpath:db/migration").load();
            assertThat(integrated.migrate().migrationsExecuted).isEqualTo(6);
            integrated.validate();
            Map<String, Integer> after = checksums(schema);
            assertThat(after).hasSize(45).containsKeys("40", "41", "42", "43", "44", "45");
            for (var migration : before.entrySet()) {
                assertThat(after.get(migration.getKey()))
                        .describedAs("Historical develop checksum V" + migration.getKey())
                        .isEqualTo(migration.getValue());
            }
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.meetings WHERE id=? AND organizer_user_id=?
                """.formatted(schema), Long.class, meeting, owner)).isEqualTo(1L);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM information_schema.tables
                WHERE table_schema=? AND table_name IN (
                  'meeting_exports', 'meeting_export_idempotency', 'meeting_export_intakes',
                  'meeting_export_reconciliation_cursor', 'meeting_export_orphan_candidates')
                """, Long.class, schema)).isEqualTo(5L);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM information_schema.tables
                WHERE table_schema=? AND table_name='processing_diarization_dispatches'
                """, Long.class, schema)).isEqualTo(1L);
            assertThat(integrated.migrate().migrationsExecuted).isZero();
            integrated.validate();
        } finally {
            jdbc.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
    }

    private Map<String,Integer> checksums(String schema) {
        Map<String,Integer> result=new LinkedHashMap<>();
        jdbc.query("""
            SELECT version,checksum FROM %s.flyway_schema_history
             WHERE success AND version IS NOT NULL ORDER BY installed_rank
            """.formatted(schema), (org.springframework.jdbc.core.RowCallbackHandler) rs -> {
                result.put(rs.getString(1), rs.getInt(2));
            });
        return result;
    }
}
