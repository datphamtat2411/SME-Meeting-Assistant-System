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
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

/**
 * T04 cross-version upgrade acceptance: real V8 historical meeting/audit
 * records survive forward-only V9 and V10, and both new FK constraints are
 * enforced by PostgreSQL. Uses an isolated schema and preserves V1-V8 checksums.
 */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class MeetingOperationsFlywayUpgradeIntegrationTests {
    @Autowired DataSource dataSource;
    @Autowired JdbcTemplate jdbc;

    @Test void historicalMeetingAndAuthAuditSurviveV8ToV10WithoutLossOrRepair() {
        String schema="t04_ops_upgrade_"+UUID.randomUUID().toString().replace("-","");
        UUID owner=UUID.randomUUID(),meeting=UUID.randomUUID();
        UUID businessAudit=UUID.randomUUID(),authAudit=UUID.randomUUID();
        try {
            Flyway before=Flyway.configure()
                .dataSource(dataSource).schemas(schema)
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("8")).load();
            before.migrate();
            String email="v8-"+owner+"@example.invalid";
            jdbc.update("""
                INSERT INTO %s.users (id,email,email_normalized,display_name,
                    global_role,account_status)
                VALUES (?,?,?,'V8 historical user','EMPLOYEE','PENDING_SETUP')
                """.formatted(schema),owner,email,email);
            jdbc.update("""
                INSERT INTO %s.meetings (id,title,organizer_user_id,
                    created_by_user_id,status)
                VALUES (?,'V8 historical meeting',?,?,'DRAFT')
                """.formatted(schema),meeting,owner,owner);
            jdbc.update("""
                INSERT INTO %s.audit_events
                  (id,occurred_at,actor_user_id,actor_type,action_code,
                   entity_type,entity_id,meeting_id,metadata)
                VALUES (?,clock_timestamp(),?,'USER','MEETING_CREATED',
                        'MEETING',?,?,'{"source":"v8"}'::jsonb)
                """.formatted(schema),businessAudit,owner,meeting,meeting);
            // Existing auth audit has no meeting context and must remain valid.
            jdbc.update("""
                INSERT INTO %s.audit_events
                  (id,occurred_at,actor_user_id,actor_type,action_code,
                   entity_type,entity_id,metadata)
                VALUES (?,clock_timestamp(),?,'SYSTEM','LOGIN_SUCCEEDED',
                        'USER',?,'{}'::jsonb)
                """.formatted(schema),authAudit,owner,owner);

            List<Integer> oldChecksums=jdbc.queryForList("""
                SELECT checksum FROM %s.flyway_schema_history
                WHERE version IN ('1','2','3','4','5','6','7','8')
                ORDER BY installed_rank
                """.formatted(schema),Integer.class);

            Flyway upgraded=Flyway.configure()
                .dataSource(dataSource).schemas(schema)
                .locations("classpath:db/migration").load();
            upgraded.migrate();
            upgraded.validate();
            List<String> versions=jdbc.queryForList("""
                SELECT version FROM %s.flyway_schema_history
                WHERE success AND version IS NOT NULL ORDER BY installed_rank
                """.formatted(schema),String.class);
            assertThat(versions).containsExactly("1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","17");
            assertThat(jdbc.queryForList("""
                SELECT checksum FROM %s.flyway_schema_history
                WHERE version IN ('1','2','3','4','5','6','7','8')
                ORDER BY installed_rank
                """.formatted(schema),Integer.class)).containsExactlyElementsOf(oldChecksums);

            assertThat(jdbc.queryForObject("""
                SELECT title FROM %s.meetings WHERE id=?
                """.formatted(schema),String.class,meeting)).isEqualTo("V8 historical meeting");
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.audit_events WHERE id IN (?,?)
                """.formatted(schema),Integer.class,businessAudit,authAudit)).isEqualTo(2);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.audit_events
                WHERE id=? AND meeting_id IS NULL
                """.formatted(schema),Integer.class,authAudit)).isEqualTo(1);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_constraint c
                JOIN pg_class r ON c.conrelid=r.oid
                JOIN pg_namespace n ON r.relnamespace=n.oid
                WHERE n.nspname=? AND r.relname='audit_events'
                  AND c.conname='fk_audit_events_meeting' AND c.contype='f'
                """,Integer.class,schema)).isEqualTo(1);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_indexes
                WHERE schemaname=? AND tablename='audit_events'
                  AND indexname='ix_audit_events_meeting_occurred'
                """,Integer.class,schema)).isEqualTo(1);

            assertThatThrownBy(() -> jdbc.update("""
                INSERT INTO %s.audit_events
                  (id,occurred_at,actor_user_id,actor_type,action_code,
                   entity_type,entity_id,meeting_id,metadata)
                VALUES (?,clock_timestamp(),?,'USER','MEETING_UPDATED',
                        'MEETING',?,?,'{}'::jsonb)
                """.formatted(schema),UUID.randomUUID(),owner,UUID.randomUUID(),UUID.randomUUID()))
                .isInstanceOf(DataIntegrityViolationException.class);

            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.meeting_creation_idempotency
                """.formatted(schema),Integer.class)).isZero();
            String digest="a".repeat(64),payload="b".repeat(64);
            jdbc.update("""
                INSERT INTO %s.meeting_creation_idempotency
                  (actor_user_id,key_digest,request_digest,meeting_id,expires_at)
                VALUES (?,?,?,?,clock_timestamp()+INTERVAL '24 hours')
                """.formatted(schema),owner,digest,payload,meeting);
            assertThat(jdbc.queryForObject("""
                SELECT meeting_id FROM %s.meeting_creation_idempotency
                WHERE actor_user_id=? AND key_digest=?
                """.formatted(schema),UUID.class,owner,digest)).isEqualTo(meeting);
            assertThatThrownBy(() -> jdbc.update("""
                INSERT INTO %s.meeting_creation_idempotency
                  (actor_user_id,key_digest,request_digest,meeting_id,expires_at)
                VALUES (?,?,?,?,clock_timestamp()+INTERVAL '24 hours')
                """.formatted(schema),owner,"c".repeat(64),payload,
                UUID.randomUUID())).isInstanceOf(DataIntegrityViolationException.class);

        } finally {
            jdbc.execute("DROP SCHEMA IF EXISTS "+schema+" CASCADE");
        }
    }
}
