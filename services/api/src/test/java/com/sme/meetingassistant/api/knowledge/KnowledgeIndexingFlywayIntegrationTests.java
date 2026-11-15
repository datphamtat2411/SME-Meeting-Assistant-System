package com.sme.meetingassistant.api.knowledge;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.media.worker.WorkerJson;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.Statement;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
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
    void migrationUpgradesV53ThroughV57WithoutRewritingTheBaseline() {
        String schema = "knowledge_t05_upgrade_" + UUID.randomUUID().toString().replace("-", "");
        try {
            Flyway before = Flyway.configure().dataSource(dataSource).schemas(schema).defaultSchema(schema)
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("53"))
                .load();
            assertThat(before.migrate().migrationsExecuted).isEqualTo(53);

            Flyway upgraded = Flyway.configure().dataSource(dataSource).schemas(schema).defaultSchema(schema)
                .locations("classpath:db/migration").load();
            assertThat(upgraded.migrate().migrationsExecuted).isEqualTo(4);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM information_schema.columns
                WHERE table_schema=? AND table_name='knowledge_qdrant_write_permits'
                  AND column_name IN ('mutation_execution_id','reserved_at','started_at','attempt_sequence')
                """, Integer.class, schema)).isEqualTo(4);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM information_schema.columns
                WHERE table_schema=? AND table_name='knowledge_source_snapshots'
                  AND column_name='selection_epoch'
                """, Integer.class, schema)).isEqualTo(1);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.flyway_schema_history
                WHERE installed_rank=53 AND version='53'
                """.formatted(schema), Integer.class)).isEqualTo(1);
            assertThat(jdbc.queryForObject("""
                SELECT version FROM %s.flyway_schema_history
                WHERE version='57'
                """.formatted(schema), String.class)).isEqualTo("57");
        } finally {
            jdbc.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
    }

    @Test
    void migrationUpgradesPopulatedV55SnapshotsAndKeepsWorkBound() {
        String schema = "knowledge_v55_" + UUID.randomUUID().toString().replace("-", "");
        try {
            Flyway.configure().dataSource(dataSource).schemas(schema).defaultSchema(schema)
                .locations("classpath:db/migration").target(MigrationVersion.fromVersion("55")).load().migrate();
            UUID user = UUID.randomUUID(), meeting = UUID.randomUUID(), source = UUID.randomUUID();
            UUID snapshot = UUID.randomUUID(), event = UUID.randomUUID();
            byte[] payload = "{}".getBytes(StandardCharsets.UTF_8);
            String sha = WorkerJson.sha256(payload);
            jdbc.update("INSERT INTO " + schema + ".users(id,email,email_normalized,display_name,password_hash,global_role,account_status) VALUES (?,?,?,'Migration test','test-only','EMPLOYEE','ACTIVE')",
                user, user + "@example.invalid", user + "@example.invalid");
            jdbc.update("INSERT INTO " + schema + ".meetings(id,title,organizer_user_id,created_by_user_id) VALUES (?,'Migration test',?,?)", meeting, user, user);
            jdbc.update("INSERT INTO " + schema + ".knowledge_source_snapshots(id,meeting_id,source_type,source_id,source_revision,payload,sha256,size_bytes) VALUES (?,?,'SUMMARY',?,7,?,?,?)",
                snapshot, meeting, source, payload, sha, payload.length);
            jdbc.update("INSERT INTO " + schema + ".outbox_events(id,aggregate_type,aggregate_id,event_type,payload) VALUES (?,'KNOWLEDGE_SOURCE',?,'KNOWLEDGE_INDEXING_REQUESTED','{}'::jsonb)", event, source);
            jdbc.update("INSERT INTO " + schema + ".knowledge_indexing_work(event_id,meeting_id,source_type,source_id,source_revision,snapshot_id,snapshot_sha256,snapshot_size_bytes,index_generation_id,configuration_version,configuration_sha256,tokenizer_id) VALUES (?,?,'SUMMARY',?,7,?,?,?,'rag-t02-bge-m3-v1','rag-t02-bge-m3-v1',?,'bge-m3')",
                event, meeting, source, snapshot, sha, payload.length, "b".repeat(64));
            assertThat(Flyway.configure().dataSource(dataSource).schemas(schema).defaultSchema(schema)
                .locations("classpath:db/migration").load().migrate().migrationsExecuted).isEqualTo(2);
            assertThat(jdbc.queryForObject("SELECT selection_epoch FROM " + schema + ".knowledge_source_snapshots WHERE id=?", Long.class, snapshot)).isZero();
            assertThat(jdbc.update("UPDATE " + schema + ".knowledge_indexing_work SET updated_at=CURRENT_TIMESTAMP WHERE event_id=?", event)).isEqualTo(1);
            assertThatThrownBy(() -> jdbc.update("UPDATE " + schema + ".knowledge_indexing_work SET source_revision=8 WHERE event_id=?", event))
                .isInstanceOf(RuntimeException.class);
        } finally {
            jdbc.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
    }

    @Test
    void migrationV57PreservesEveryHistoricalPermitStateAndReplacesOnlyUnresolvedUniqueness()
        throws Exception {
        String schema = "knowledge_v57_states_" + UUID.randomUUID().toString().replace("-", "");
        try {
            Flyway.configure().dataSource(dataSource).schemas(schema).defaultSchema(schema)
                .locations("classpath:db/migration").target(MigrationVersion.fromVersion("56")).load().migrate();

            UUID user = UUID.randomUUID(), meeting = UUID.randomUUID();
            byte[] payload = "{}".getBytes(StandardCharsets.UTF_8);
            String sha = WorkerJson.sha256(payload);
            jdbc.update("INSERT INTO " + schema
                + ".users(id,email,email_normalized,display_name,password_hash,global_role,account_status)"
                + " VALUES (?,?,?,'Permit migration test','test-only','EMPLOYEE','ACTIVE')",
                user, user + "@example.invalid", user + "@example.invalid");
            jdbc.update("INSERT INTO " + schema
                + ".meetings(id,title,organizer_user_id,created_by_user_id) VALUES (?,'Permit migration test',?,?)",
                meeting, user, user);

            String generation = "rag-t02-bge-m3-v1";
            UUID[] events = new UUID[6];
            UUID[] claimTokens = new UUID[6];
            for (int i = 0; i < events.length; i++) {
                UUID source = UUID.randomUUID();
                UUID snapshot = UUID.randomUUID();
                events[i] = UUID.randomUUID();
                claimTokens[i] = UUID.randomUUID();
                jdbc.update("INSERT INTO " + schema
                    + ".knowledge_source_snapshots(id,meeting_id,source_type,source_id,source_revision,"
                    + "payload,sha256,size_bytes) VALUES (?,?,'ACTION_ITEM',?,0,?,?,?)",
                    snapshot, meeting, source, payload, sha, payload.length);
                jdbc.update("INSERT INTO " + schema
                    + ".outbox_events(id,aggregate_type,aggregate_id,event_type,payload)"
                    + " VALUES (?,'KNOWLEDGE_SOURCE',?,'KNOWLEDGE_INDEXING_REQUESTED','{}'::jsonb)",
                    events[i], source);
                jdbc.update("INSERT INTO " + schema
                    + ".knowledge_indexing_work(event_id,meeting_id,source_type,source_id,source_revision,"
                    + "snapshot_id,snapshot_sha256,snapshot_size_bytes,index_generation_id,configuration_version,"
                    + "configuration_sha256,tokenizer_id)"
                    + " VALUES (?,?,'ACTION_ITEM',?,0,?,?,?,'rag-t02-bge-m3-v1','rag-t02-bge-m3-v1',?,'bge-m3')",
                    events[i], meeting, source, snapshot, sha, payload.length, "b".repeat(64));
            }
            long epoch = jdbc.queryForObject("SELECT write_epoch FROM " + schema
                + ".knowledge_index_generations WHERE generation_id=?", Long.class, generation);
            String[] states = {"OPEN", "RESERVED", "RUNNING", "CANCELLED", "SUCCEEDED", "FAILED"};
            try (Connection connection = dataSource.getConnection()) {
                connection.setAutoCommit(false);
                try {
                    try (Statement statement = connection.createStatement()) {
                        statement.execute("SET LOCAL search_path TO " + schema + ", public");
                    }
                    JdbcTemplate jdbc = new JdbcTemplate(
                        new SingleConnectionDataSource(connection, true));
                    for (int i = 0; i < states.length; i++) {
                        String tokenHash = WorkerJson.sha256(
                            claimTokens[i].toString().getBytes(StandardCharsets.US_ASCII));
                        String certificate = "c".repeat(64);
                        UUID permit = UUID.randomUUID();
                        if ("OPEN".equals(states[i])) {
                            jdbc.update("INSERT INTO " + schema
                                + ".knowledge_qdrant_write_permits(permit_id,generation_id,event_id,operation,"
                                + "claim_token_sha256,worker_certificate_sha256,generation_epoch,state)"
                                + " VALUES (?,? ,?,'UPSERT',?,?,?,'OPEN')",
                                permit, generation, events[i], tokenHash, certificate, epoch);
                        } else if ("RESERVED".equals(states[i])) {
                            jdbc.update("INSERT INTO " + schema
                                + ".knowledge_qdrant_write_permits(permit_id,generation_id,event_id,operation,"
                                + "claim_token_sha256,worker_certificate_sha256,generation_epoch,state,"
                                + "mutation_execution_id,reserved_at)"
                                + " VALUES (?,? ,?,'UPSERT',?,?,?,'RESERVED',?,CURRENT_TIMESTAMP)",
                                permit, generation, events[i], tokenHash, certificate, epoch, UUID.randomUUID());
                        } else if ("RUNNING".equals(states[i])) {
                            jdbc.update("INSERT INTO " + schema
                                + ".knowledge_qdrant_write_permits(permit_id,generation_id,event_id,operation,"
                                + "claim_token_sha256,worker_certificate_sha256,generation_epoch,state,"
                                + "mutation_execution_id,reserved_at,started_at)"
                                + " VALUES (?,? ,?,'UPSERT',?,?,?,'RUNNING',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
                                permit, generation, events[i], tokenHash, certificate, epoch, UUID.randomUUID());
                        } else if ("CANCELLED".equals(states[i])) {
                            jdbc.update("INSERT INTO " + schema
                                + ".knowledge_qdrant_write_permits(permit_id,generation_id,event_id,operation,"
                                + "claim_token_sha256,worker_certificate_sha256,generation_epoch,state,"
                                + "mutation_execution_id,reserved_at,completed_at,outcome_code,outcome_summary)"
                                + " VALUES (?,? ,?,'UPSERT',?,?,?,'CANCELLED',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,"
                                + "'WORKER_PERMIT_STALE','migration fixture')",
                                permit, generation, events[i], tokenHash, certificate, epoch, UUID.randomUUID());
                        } else {
                            jdbc.update("INSERT INTO " + schema
                                + ".knowledge_qdrant_write_permits(permit_id,generation_id,event_id,operation,"
                                + "claim_token_sha256,worker_certificate_sha256,generation_epoch,state,"
                                + "mutation_execution_id,reserved_at,started_at,completed_at,outcome_code)"
                                + " VALUES (?,? ,?,'UPSERT',?,?,?,'" + states[i] + "',?,CURRENT_TIMESTAMP,"
                                + "CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?)",
                                permit, generation, events[i], tokenHash, certificate, epoch, UUID.randomUUID(),
                                "SUCCEEDED".equals(states[i]) ? "NONE" : "QDRANT_UNAVAILABLE");
                        }
                    }
                    connection.commit();
                } catch (Exception exception) {
                    connection.rollback();
                    throw exception;
                }
            }

            assertThat(Flyway.configure().dataSource(dataSource).schemas(schema).defaultSchema(schema)
                .locations("classpath:db/migration").load().migrate().migrationsExecuted).isEqualTo(1);
            String permitBindingFunction = jdbc.queryForObject("""
                SELECT pg_get_functiondef(p.oid)
                  FROM pg_proc p
                  JOIN pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname=? AND p.proname='protect_knowledge_permit_binding'
                   AND p.pronargs=0
                """, String.class, schema);
            assertThat(permitBindingFunction).contains("TG_TABLE_SCHEMA");
            assertThat(jdbc.queryForList("SELECT state FROM " + schema
                + ".knowledge_qdrant_write_permits ORDER BY attempt_sequence", String.class))
                .containsExactlyInAnyOrder(states);
            assertThat(jdbc.queryForObject("SELECT COUNT(DISTINCT attempt_sequence) FROM " + schema
                + ".knowledge_qdrant_write_permits", Integer.class)).isEqualTo(6);
            assertThat(jdbc.queryForObject("""
                SELECT COUNT(*) FROM pg_indexes
                 WHERE schemaname=? AND indexname='ux_knowledge_permit_unresolved_attempt'
                """, Integer.class, schema))
                .isEqualTo(1);
            assertThat(jdbc.queryForObject("""
                SELECT COUNT(*) FROM pg_constraint c
                 JOIN pg_namespace n ON n.oid=c.connamespace
                 WHERE n.nspname=? AND c.conname='ux_knowledge_permit_attempt'
                """, Integer.class, schema)).isZero();

            UUID openEvent = events[0];
            String openHash = WorkerJson.sha256(claimTokens[0].toString().getBytes(StandardCharsets.US_ASCII));
            assertThatThrownBy(() -> jdbc.update("INSERT INTO " + schema
                + ".knowledge_qdrant_write_permits(permit_id,generation_id,event_id,operation,"
                + "claim_token_sha256,worker_certificate_sha256,generation_epoch,state)"
                + " VALUES (?,? ,?,'UPSERT',?,?,?,'OPEN')",
                UUID.randomUUID(), generation, openEvent, openHash, "c".repeat(64), epoch))
                .isInstanceOf(RuntimeException.class);
            jdbc.update("INSERT INTO " + schema
                + ".knowledge_qdrant_write_permits(permit_id,generation_id,event_id,operation,"
                + "claim_token_sha256,worker_certificate_sha256,generation_epoch,state,"
                + "mutation_execution_id,reserved_at,completed_at,outcome_code,outcome_summary)"
                + " VALUES (?,? ,?,'UPSERT',?,?,?,'CANCELLED',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,"
                + "'WORKER_PERMIT_STALE','second historical attempt')",
                UUID.randomUUID(), generation, openEvent, openHash, "c".repeat(64), epoch, UUID.randomUUID());
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM " + schema
                + ".knowledge_qdrant_write_permits WHERE event_id=?", Integer.class, openEvent)).isEqualTo(2);
        } finally {
            jdbc.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
    }
}
