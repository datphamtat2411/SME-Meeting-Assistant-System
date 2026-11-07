package com.sme.meetingassistant.api.media.diarization;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
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
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * MERGE-04: production-shaped Flyway paths for the V34 Action Items baseline and
 * forward-only diarization V35-V39. Each test uses a disposable PostgreSQL schema.
 */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class DiarizationFlywayUpgradeIntegrationTests {
    private static final String SOURCE_SHA = "a".repeat(64);
    private static final String RESULT_SHA = "b".repeat(64);

    @Autowired DataSource dataSource;
    @Autowired JdbcTemplate jdbc;
    @Autowired PlatformTransactionManager transactionManager;

    private record Fixture(UUID actor, UUID meeting, UUID media, UUID job, UUID transcript,
                           UUID segment, UUID speaker, UUID action, UUID assignmentEvent) {}

    private String schema() {
        return "spk_merge04_" + UUID.randomUUID().toString().replace("-", "");
    }

    private Flyway flyway(String schema, String target) {
        var configuration = Flyway.configure().dataSource(dataSource).schemas(schema)
            .defaultSchema(schema).locations("classpath:db/migration");
        if (target != null) configuration.target(MigrationVersion.fromVersion(target));
        return configuration.load();
    }

    private List<Map<String, Object>> history(String schema, int through) {
        return jdbc.queryForList("""
            SELECT version, checksum FROM %s.flyway_schema_history
            WHERE version::integer <= %d ORDER BY installed_rank
            """.formatted(schema, through));
    }

    private long count(String schema, String table) {
        return jdbc.queryForObject("SELECT count(*) FROM " + schema + "." + table, Long.class);
    }

    private Fixture seedCanonicalHistory(String schema, boolean diarizationPlanned) {
        UUID actor = UUID.randomUUID(), meeting = UUID.randomUUID(), media = UUID.randomUUID();
        UUID job = UUID.randomUUID(), finalStage = UUID.randomUUID();
        UUID transcript = UUID.randomUUID(), segment = UUID.randomUUID(), speaker = UUID.randomUUID();
        UUID action = UUID.randomUUID(), assignmentEvent = UUID.randomUUID(), historyId = UUID.randomUUID();

        String email = "spk-merge04-" + actor + "@example.invalid";
        jdbc.update("""
            INSERT INTO %s.users(id,email,email_normalized,display_name,password_hash,global_role,account_status)
            VALUES (?,?,?,'Historical meeting actor','test-only','EMPLOYEE','ACTIVE')
            """.formatted(schema), actor, email, email);
        jdbc.update("""
            INSERT INTO %s.meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Existing meeting before diarization',?,?)
            """.formatted(schema), meeting, actor, actor);
        jdbc.update("""
            INSERT INTO %s.meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                content_type,expected_size_bytes,size_bytes,duration_ms,sha256,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',1024,1024,10000,?,?,clock_timestamp())
            """.formatted(schema), media, meeting,
            "meetings/" + meeting + "/sources/" + media,
            "meetings/" + meeting + "/pending/" + media, SOURCE_SHA, actor);
        if (diarizationPlanned) {
            jdbc.update("""
                INSERT INTO %s.processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,
                    status,diarization_planned) VALUES (?,?,?,?,'PENDING',true)
                """.formatted(schema), job, meeting, media, actor);
        } else {
            jdbc.update("""
                INSERT INTO %s.processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status)
                VALUES (?,?,?,?,'PENDING')
                """.formatted(schema), job, meeting, media, actor);
        }
        jdbc.update("""
            INSERT INTO %s.processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,'FINALIZING_TRANSCRIPT',1,'SUCCEEDED')
            """.formatted(schema), finalStage, job);
        jdbc.update("""
            INSERT INTO %s.transcripts(id,meeting_id,source_media_id,processing_job_id,source_stage_run_id,
                version_number,language_code,status,is_current,duration_ms,content_revision)
            VALUES (?,?,?,?,?,1,'vi','READY',true,10000,2)
            """.formatted(schema), transcript, meeting, media, job, finalStage);
        jdbc.update("""
            INSERT INTO %s.speaker_clusters(id,transcript_id,label) VALUES (?,?,'SPEAKER_00')
            """.formatted(schema), speaker, transcript);
        jdbc.update("""
            INSERT INTO %s.transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,current_text,
                quality_status,speaker_cluster_id,source_stage_run_id,corrected_by_user_id,corrected_at,version)
            VALUES (?,?,0,0,1000,'Human-corrected transcript','ACCEPTED',?,?,?,clock_timestamp(),2)
            """.formatted(schema), segment, transcript, speaker, finalStage, actor);
        jdbc.update("""
            INSERT INTO %s.transcript_segment_revisions(id,segment_id,revision_number,previous_text,
                new_text,edited_by_user_id,edit_reason)
            VALUES (?,?,1,'Earlier ASR text','Human-corrected transcript',?,'Human review')
            """.formatted(schema), UUID.randomUUID(), segment, actor);
        jdbc.update("""
            INSERT INTO %s.speaker_mappings(id,speaker_cluster_id,user_id,mapped_by_user_id)
            VALUES (?,?,?,?)
            """.formatted(schema), UUID.randomUUID(), speaker, actor, actor);
        jdbc.update("""
            INSERT INTO %s.action_items(id,meeting_id,title,status,source_type,
                assignee_user_id,created_by_user_id)
            VALUES (?,?,'Historical manual action item','OPEN','MANUAL',?,?)
            """.formatted(schema), action, meeting, actor, actor);
        jdbc.update("""
            INSERT INTO %s.action_item_history(id,action_item_id,change_type,from_value,to_value,changed_by_user_id)
            VALUES (?,?,'ASSIGNEE',NULL,?,?)
            """.formatted(schema), historyId, action, actor.toString(), actor);
        jdbc.update("""
            INSERT INTO %s.action_item_assignment_events
                (id,action_item_id,action_item_version,history_id,assignee_user_id,event_type)
            VALUES (?,?,0,?,?,'ASSIGNED')
            """.formatted(schema), assignmentEvent, action, historyId, actor);
        jdbc.update("""
            INSERT INTO %s.user_preferences(user_id,timezone,locale,meeting_email_enabled,
                action_item_email_enabled)
            VALUES (?,'Asia/Ho_Chi_Minh','vi',false,false)
            """.formatted(schema), actor);

        return new Fixture(actor, meeting, media, job, transcript, segment, speaker, action, assignmentEvent);
    }

    @Test
    void populatedV34CanonicalDataUpgradesThroughV39WithoutHistoricalRewrites() {
        String schema = schema();
        try {
            Flyway previous = flyway(schema, "34");
            assertThat(previous.migrate().migrationsExecuted).isEqualTo(34);
            previous.validate();
            Fixture old = seedCanonicalHistory(schema, false);
            var historicalChecksums = history(schema, 34);
            assertThat(historicalChecksums).hasSize(34);

            Flyway upgraded = flyway(schema, null);
            assertThat(upgraded.migrate().migrationsExecuted).isEqualTo(5);
            upgraded.validate();
            assertThat(history(schema, 34)).containsExactlyElementsOf(historicalChecksums);
            assertThat(jdbc.queryForList("""
                SELECT version FROM %s.flyway_schema_history WHERE success AND version IS NOT NULL
                ORDER BY installed_rank
                """.formatted(schema), String.class)).hasSize(39).endsWith("35", "36", "37", "38", "39");

            assertThat(jdbc.queryForObject("""
                SELECT diarization_planned FROM %s.processing_jobs WHERE id=?
                """.formatted(schema), Boolean.class, old.job())).isFalse();
            assertThat(jdbc.queryForObject("""
                SELECT current_text FROM %s.transcript_segments WHERE id=?
                """.formatted(schema), String.class, old.segment())).isEqualTo("Human-corrected transcript");
            assertThat(jdbc.queryForObject("""
                SELECT content_revision FROM %s.transcripts WHERE id=?
                """.formatted(schema), Long.class, old.transcript())).isEqualTo(2L);
            assertThat(jdbc.queryForObject("""
                SELECT version FROM %s.transcript_segments WHERE id=?
                """.formatted(schema), Long.class, old.segment())).isEqualTo(2L);
            assertThat(count(schema, "transcript_segment_revisions")).isEqualTo(1);
            assertThat(count(schema, "speaker_mappings")).isEqualTo(1);
            assertThat(jdbc.queryForObject("""
                SELECT title FROM %s.action_items WHERE id=?
                """.formatted(schema), String.class, old.action())).isEqualTo("Historical manual action item");
            assertThat(jdbc.queryForObject("""
                SELECT event_type FROM %s.action_item_assignment_events WHERE id=?
                """.formatted(schema), String.class, old.assignmentEvent())).isEqualTo("ASSIGNED");
            assertThat(jdbc.queryForObject("""
                SELECT meeting_email_enabled FROM %s.user_preferences WHERE user_id=?
                """.formatted(schema), Boolean.class, old.actor())).isFalse();
            assertThat(jdbc.queryForObject("""
                SELECT action_item_email_enabled FROM %s.user_preferences WHERE user_id=?
                """.formatted(schema), Boolean.class, old.actor())).isFalse();

            // Existing admitted jobs cannot silently gain diarization after upgrade.
            assertThat(count(schema, "processing_diarization_dispatches")).isZero();
            assertThatThrownBy(() -> jdbc.update("""
                UPDATE %s.processing_jobs SET diarization_planned=true WHERE id=?
                """.formatted(schema), old.job())).isInstanceOf(DataIntegrityViolationException.class);
            assertThatThrownBy(() -> jdbc.update("""
                INSERT INTO %s.processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
                VALUES (?,?,'DIARIZING',1,'PENDING')
                """.formatted(schema), UUID.randomUUID(), old.job()))
                .isInstanceOf(DataIntegrityViolationException.class);

            for (String table : List.of("processing_diarization_dispatches", "diarization_worker_claims",
                    "diarization_worker_commands", "diarization_worker_verifications",
                    "diarization_worker_receipts", "diarization_acceptance_measurements")) {
                assertThat(jdbc.queryForObject("""
                    SELECT count(*) FROM information_schema.tables WHERE table_schema=? AND table_name=?
                    """, Long.class, schema, table)).describedAs(table).isEqualTo(1);
            }
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM information_schema.views WHERE table_schema=?
                    AND table_name='diarization_verified_only_backlog'
                """, Long.class, schema)).isEqualTo(1);
            assertThat(upgraded.migrate().migrationsExecuted).isZero();
            upgraded.validate();
        } finally {
            jdbc.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
    }

    private UUID seedV36AcceptedReceipt(String schema, Fixture source) {
        UUID stage = UUID.randomUUID(), event = UUID.randomUUID(), claimRequest = UUID.randomUUID();
        UUID claimToken = UUID.randomUUID(), command = UUID.randomUUID();
        UUID verification = UUID.randomUUID(), receipt = UUID.randomUUID();

        // Both V36 acceptance constraints are deferred: stage and receipt must commit together.
        new TransactionTemplate(transactionManager).executeWithoutResult(transaction -> {
            jdbc.execute("SET LOCAL search_path TO " + schema + ",public");
            jdbc.update("""
                INSERT INTO %s.processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
                VALUES (?,?,'DIARIZING',1,'SUCCEEDED')
                """.formatted(schema), stage, source.job());
            jdbc.update("""
                INSERT INTO %s.outbox_events(id,aggregate_type,aggregate_id,event_type,payload)
                VALUES (?,'PROCESSING_JOB',?,'PROCESSING_DIARIZATION_REQUESTED',CAST(? AS jsonb))
                """.formatted(schema), event, source.job(),
                "{\"schemaVersion\":1,\"stageRunId\":\"" + stage + "\",\"eventId\":\"" + event + "\"}");
            jdbc.update("""
                INSERT INTO %s.processing_diarization_dispatches(stage_run_id,processing_job_id,
                    meeting_id,source_media_id,source_revision,transcript_id,transcript_revision,
                    event_id,created_at)
                VALUES (?,?,?,?,?,?,?,?,clock_timestamp())
                """.formatted(schema), stage, source.job(), source.meeting(), source.media(),
                SOURCE_SHA, source.transcript(), 2L, event);
            jdbc.update("""
                INSERT INTO %s.diarization_worker_claims(event_id,processing_job_id,execution_stage_run_id,
                    principal,claim_request_id,request_sha256,claim_token,source_descriptor)
                VALUES (?,?,?,'urn:sme:service:ai-worker',?,?,?,CAST('{}' AS jsonb))
                """.formatted(schema), event, source.job(), stage, claimRequest, SOURCE_SHA, claimToken);
            jdbc.update("""
                INSERT INTO %s.diarization_worker_commands(command_id,processing_job_id,event_id,
                    execution_stage_run_id,command_type,request_sha256)
                VALUES (?,?,?,?,'COMPLETE',?)
                """.formatted(schema), command, source.job(), event, stage, SOURCE_SHA);
            jdbc.update("""
                INSERT INTO %s.diarization_worker_verifications(verification_id,processing_job_id,
                    event_id,execution_stage_run_id,producer_stage_run_id,command_id,source_revision,
                    transcript_id,transcript_revision,result_sha256,storage_id,object_key,size_bytes)
                VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,128)
                """.formatted(schema), verification, source.job(), event, stage, stage, command,
                SOURCE_SHA, source.transcript(), 2L, RESULT_SHA, "historical",
                "processing/" + source.job() + "/diarization/results/" + stage + ".json");
            jdbc.update("""
                INSERT INTO %s.diarization_worker_receipts(receipt_id,processing_job_id,event_id,
                    execution_stage_run_id,command_id,outcome,verification_id)
                VALUES (?,?,?,?,?,'RESULT_ACCEPTED',?)
                """.formatted(schema), receipt, source.job(), event, stage, command, verification);
        });
        return receipt;
    }

    @Test
    void existingV36AcceptedReceiptSurvivesV37MeasurementIntroductionWithoutBackfill() {
        String schema = schema();
        try {
            Flyway before = flyway(schema, "36");
            assertThat(before.migrate().migrationsExecuted).isEqualTo(36);
            before.validate();
            Fixture source = seedCanonicalHistory(schema, true);
            UUID existingReceipt = seedV36AcceptedReceipt(schema, source);
            var preservedHistory = history(schema, 36);
            assertThat(count(schema, "diarization_worker_receipts")).isEqualTo(1);

            Flyway measurementUpgrade = flyway(schema, "37");
            assertThat(measurementUpgrade.migrate().migrationsExecuted).isEqualTo(1);
            measurementUpgrade.validate();
            assertThat(history(schema, 36)).containsExactlyElementsOf(preservedHistory);
            assertThat(jdbc.queryForObject("""
                SELECT outcome FROM %s.diarization_worker_receipts WHERE receipt_id=?
                """.formatted(schema), String.class, existingReceipt)).isEqualTo("RESULT_ACCEPTED");
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.diarization_acceptance_measurements WHERE receipt_id=?
                """.formatted(schema), Long.class, existingReceipt)).isZero();

            // New acceptances require measurements, but a historical V36 receipt is not
            // fabricated retroactively from mutable transcript information.
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname=? AND c.relname='diarization_worker_receipts'
                    AND t.tgname='trg_diarization_acceptance_measurement'
                """, Long.class, schema)).isEqualTo(1);

            Flyway latest = flyway(schema, null);
            assertThat(latest.migrate().migrationsExecuted).isEqualTo(2);
            latest.validate();
            assertThat(history(schema, 36)).containsExactlyElementsOf(preservedHistory);
            assertThat(count(schema, "diarization_worker_verifications")).isEqualTo(1);
            assertThat(count(schema, "diarization_worker_receipts")).isEqualTo(1);
            assertThat(count(schema, "diarization_acceptance_measurements")).isZero();
            assertThat(count(schema, "diarization_verified_only_backlog")).isZero();
            assertThat(latest.migrate().migrationsExecuted).isZero();
        } finally {
            jdbc.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
    }

    @Test
    void freshSchemaInstallsV1ThroughV39AndValidatesWithoutRepairOrRepeat() {
        String schema = schema();
        try {
            Flyway fresh = flyway(schema, null);
            assertThat(fresh.migrate().migrationsExecuted).isEqualTo(39);
            fresh.validate();
            assertThat(history(schema, 39)).hasSize(39);
            assertThat(jdbc.queryForObject("""
                SELECT version FROM %s.flyway_schema_history WHERE success
                    AND version IS NOT NULL ORDER BY installed_rank DESC LIMIT 1
                """.formatted(schema), String.class)).isEqualTo("39");
            assertThat(fresh.migrate().migrationsExecuted).isZero();
            fresh.validate();
        } finally {
            jdbc.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
    }
}
