package com.sme.meetingassistant.api.knowledge;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.media.worker.WorkerJson;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.nio.charset.StandardCharsets;
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

@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class KnowledgeIndexingFlywayIntegrationTests {
    @Autowired DataSource dataSource;
    @Autowired JdbcTemplate jdbc;

    @Test
    void migrationCreatesImmutableSnapshotAndFencedWorkIdentity() {
        String schema = "knowledge_t05_" + UUID.randomUUID().toString().replace("-", "");
        try {
            Flyway.configure().dataSource(dataSource).schemas(schema).defaultSchema(schema)
                .locations("classpath:db/migration").load().migrate();

            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM information_schema.tables
                WHERE table_schema=? AND table_name IN ('knowledge_source_snapshots','knowledge_indexing_work',
                    'knowledge_index_generations','knowledge_reconciliation_runs','knowledge_reconciliation_findings')
                """, Integer.class, schema)).isEqualTo(5);
            assertThat(jdbc.queryForObject("SELECT state FROM " + schema
                + ".knowledge_index_generations WHERE generation_id='rag-t02-bge-m3-v1'", String.class))
                .isEqualTo("ACTIVE");

            UUID userId = UUID.randomUUID();
            UUID meetingId = UUID.randomUUID();
            UUID sourceId = UUID.randomUUID();
            UUID snapshotId = UUID.randomUUID();
            UUID eventId = UUID.randomUUID();
            byte[] payload = "{}".getBytes(StandardCharsets.UTF_8);
            String sha = WorkerJson.sha256(payload);
            jdbc.update("""
                INSERT INTO %s.users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
                VALUES (?,? ,?,'Knowledge test user','test-only','EMPLOYEE','ACTIVE')
                """.formatted(schema), userId, userId + "@example.invalid", userId + "@example.invalid");
            jdbc.update("""
                INSERT INTO %s.meetings(id,title,organizer_user_id,created_by_user_id)
                VALUES (?,'Knowledge test meeting',?,?)
                """.formatted(schema), meetingId, userId, userId);
            jdbc.update("""
                INSERT INTO %s.knowledge_source_snapshots(
                    id,meeting_id,source_type,source_id,source_revision,payload,sha256,size_bytes)
                VALUES (?,?, 'SUMMARY',?,7,?,?,?)
                """.formatted(schema), snapshotId, meetingId, sourceId, payload, sha, payload.length);
            jdbc.update("""
                INSERT INTO %s.outbox_events(id,aggregate_type,aggregate_id,event_type,payload)
                VALUES (?, 'KNOWLEDGE_SOURCE',?,'KNOWLEDGE_INDEXING_REQUESTED','{}'::jsonb)
                """.formatted(schema), eventId, sourceId);
            jdbc.update("""
                INSERT INTO %s.knowledge_indexing_work(
                    event_id,meeting_id,source_type,source_id,source_revision,snapshot_id,
                    snapshot_sha256,snapshot_size_bytes,index_generation_id,configuration_version,
                    configuration_sha256,tokenizer_id)
                VALUES (?,?,'SUMMARY',?,7,?,?,?,'rag-t02-bge-m3-v1','rag-t02-bge-m3-v1',?,'bge-m3')
                """.formatted(schema), eventId, meetingId, sourceId, snapshotId, sha, payload.length,
                "b".repeat(64));

            assertThatThrownBy(() -> jdbc.update("""
                INSERT INTO %s.knowledge_index_generations(
                    generation_id,configuration_version,configuration_sha256,tokenizer_id,collection_name)
                VALUES ('rag-t02-bge-m3-v2','rag-t02-bge-m3-v2',?,'tokenizer-v2','sme_meeting_knowledge_bge_m3')
                """.formatted(schema), "c".repeat(64))).isInstanceOf(RuntimeException.class);
            assertThatThrownBy(() -> jdbc.update("DELETE FROM " + schema
                + ".knowledge_index_generations WHERE generation_id='rag-t02-bge-m3-v1'"))
                .isInstanceOf(RuntimeException.class);

            assertThatThrownBy(() -> jdbc.update("UPDATE " + schema
                + ".knowledge_source_snapshots SET payload=? WHERE id=?", "changed".getBytes(), snapshotId))
                .isInstanceOf(RuntimeException.class);
            assertThatThrownBy(() -> jdbc.update("UPDATE " + schema
                + ".knowledge_indexing_work SET source_revision=8 WHERE event_id=?", eventId))
                .isInstanceOf(RuntimeException.class);
            assertThatThrownBy(() -> jdbc.update("UPDATE " + schema
                + ".outbox_events SET payload='{\"changed\":true}'::jsonb WHERE id=?", eventId))
                .isInstanceOf(RuntimeException.class);
        } finally {
            jdbc.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
    }

    @Test
    void migrationUpgradesV53ToV54WithoutRewritingTheBaseline() {
        String schema = "knowledge_t05_upgrade_" + UUID.randomUUID().toString().replace("-", "");
        try {
            Flyway before = Flyway.configure().dataSource(dataSource).schemas(schema).defaultSchema(schema)
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("53"))
                .load();
            assertThat(before.migrate().migrationsExecuted).isEqualTo(53);

            Flyway upgraded = Flyway.configure().dataSource(dataSource).schemas(schema).defaultSchema(schema)
                .locations("classpath:db/migration").load();
            assertThat(upgraded.migrate().migrationsExecuted).isEqualTo(1);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM information_schema.columns
                WHERE table_schema=? AND table_name='knowledge_qdrant_write_permits'
                  AND column_name IN ('mutation_execution_id','reserved_at','started_at')
                """, Integer.class, schema)).isEqualTo(3);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.flyway_schema_history
                WHERE installed_rank=53 AND version='53'
                """.formatted(schema), Integer.class)).isEqualTo(1);
        } finally {
            jdbc.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
    }
}
