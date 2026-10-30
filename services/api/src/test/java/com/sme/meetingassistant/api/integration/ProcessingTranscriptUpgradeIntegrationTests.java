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

/** INT-02: real forward upgrades with historically persisted cross-module rows. */
@ActiveProfiles("test")
@SpringBootTest(properties = "app.media.outbox.enabled=false")
@Import(PostgresTestConfiguration.class)
class ProcessingTranscriptUpgradeIntegrationTests {
    @Autowired DataSource source;
    @Autowired JdbcTemplate jdbc;

    private String schema() {
        return "int02_" + UUID.randomUUID().toString().replace("-", "");
    }

    private Flyway flyway(String schema, int version) {
        return Flyway.configure().dataSource(source).schemas(schema)
            .locations("classpath:db/migration")
            .target(MigrationVersion.fromVersion(Integer.toString(version))).load();
    }

    private Flyway latest(String schema) {
        return Flyway.configure().dataSource(source).schemas(schema)
            .locations("classpath:db/migration").load();
    }

    private void cleanup(String schema) {
        jdbc.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    }

    private void seedIdentity(String schema, UUID actor, UUID meeting, UUID media, UUID job) {
        String email = "upgrade-int02-" + actor + "@example.invalid";
        jdbc.update("""
            INSERT INTO %s.users(id,email,email_normalized,display_name,password_hash,
                global_role,account_status)
            VALUES (?,?,?,'Legacy worker','test-only','EMPLOYEE','ACTIVE')
            """.formatted(schema), actor, email, email);
        jdbc.update("""
            INSERT INTO %s.meetings(id,title,organizer_user_id,created_by_user_id)
            VALUES (?,'Historical processing job',?,?)
            """.formatted(schema), meeting, actor, actor);
        jdbc.update("""
            INSERT INTO %s.meeting_media(id,meeting_id,source_type,status,object_key,pending_object_key,
                content_type,expected_size_bytes,size_bytes,duration_ms,uploaded_by_user_id,available_at)
            VALUES (?,?,'UPLOAD','AVAILABLE',?,?,'audio/wav',1000,1000,10000,?,CURRENT_TIMESTAMP)
            """.formatted(schema), media, meeting,
            "meetings/" + meeting + "/sources/" + media,
            "meetings/" + meeting + "/pending/" + media, actor);
        jdbc.update("""
            INSERT INTO %s.processing_jobs(id,meeting_id,source_media_id,requested_by_user_id,status)
            VALUES (?,?,?,?,'COMPLETED')
            """.formatted(schema), job, meeting, media, actor);
    }

    private void stage(String schema, UUID id, UUID job, String code) {
        jdbc.update("""
            INSERT INTO %s.processing_stage_runs(id,processing_job_id,stage_code,attempt_number,status)
            VALUES (?,?,?,1,'SUCCEEDED')
            """.formatted(schema), id, job, code);
    }

    @Test
    void v15ProcessingJobAndAcceptedMediaUpgradeThroughV22WithoutLosingHistory() {
        String schema = schema();
        UUID actor=UUID.randomUUID(),meeting=UUID.randomUUID(),
            media=UUID.randomUUID(),job=UUID.randomUUID(),stage=UUID.randomUUID();
        try {
            flyway(schema, 15).migrate();
            seedIdentity(schema,actor,meeting,media,job);
            Integer checksum = jdbc.queryForObject("""
                SELECT checksum FROM %s.flyway_schema_history WHERE version='15'
                """.formatted(schema), Integer.class);
            Flyway upgraded = latest(schema);
            upgraded.migrate();
            upgraded.validate();

            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.processing_jobs WHERE id=? AND source_media_id=?
                  AND status='COMPLETED'
                """.formatted(schema), Integer.class, job, media)).isEqualTo(1);
            assertThat(jdbc.queryForObject("""
                SELECT status FROM %s.meeting_media WHERE id=?
                """.formatted(schema), String.class, media)).isEqualTo("AVAILABLE");
            assertThat(jdbc.queryForObject("""
                SELECT checksum FROM %s.flyway_schema_history WHERE version='15'
                """.formatted(schema), Integer.class)).isEqualTo(checksum);
            assertThat(jdbc.queryForList("""
                SELECT version FROM %s.flyway_schema_history
                WHERE success AND version IS NOT NULL ORDER BY installed_rank
                """.formatted(schema), String.class))
                .containsExactly("1","2","3","4","5","6","7","8","9","10","11","12","13",
                    "14","15","16","17","18","19","20","21","22");
            stage(schema,stage,job,"FINALIZING_TRANSCRIPT");
            UUID transcript = UUID.randomUUID();
            jdbc.update("""
                INSERT INTO %s.transcripts(id,meeting_id,source_media_id,processing_job_id,
                  source_stage_run_id,version_number,language_code,status)
                VALUES (?,?,?,?,?,1,'vi','READY')
                """.formatted(schema), transcript, meeting, media, job, stage);
            assertThat(jdbc.queryForObject("""
                SELECT source_stage_code FROM %s.transcripts WHERE id=?
                """.formatted(schema), String.class, transcript))
                .isEqualTo("FINALIZING_TRANSCRIPT");
        } finally {
            cleanup(schema);
        }
    }

    @Test
    void v17CanonicalTranscriptAndHumanReviewRemainIntactAfterForwardUpgrade() {
        String schema = schema();
        UUID actor=UUID.randomUUID(),meeting=UUID.randomUUID(),
            media=UUID.randomUUID(),job=UUID.randomUUID(),
            finalizer=UUID.randomUUID(), upstream=UUID.randomUUID(),
            transcript=UUID.randomUUID(), segment=UUID.randomUUID();
        try {
            flyway(schema,17).migrate();
            seedIdentity(schema,actor,meeting,media,job);
            stage(schema,finalizer,job,"FINALIZING_TRANSCRIPT");
            stage(schema,upstream,job,"TRANSCRIPTION");
            jdbc.update("""
                INSERT INTO %s.transcripts(id,meeting_id,source_media_id,processing_job_id,
                  source_stage_run_id,version_number,language_code,status,is_current)
                VALUES (?,?,?,?,?,1,'vi','READY',TRUE)
                """.formatted(schema), transcript,meeting,media,job,finalizer);
            jdbc.update("""
                INSERT INTO %s.transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,
                  current_text,quality_status,source_stage_run_id)
                VALUES (?,?,0,100,1400,'Human accepted text.','ACCEPTED',?)
                """.formatted(schema),segment,transcript,upstream);
            jdbc.update("""
                INSERT INTO %s.transcript_segment_revisions(id,segment_id,revision_number,
                  previous_text,new_text,edited_by_user_id)
                VALUES (?,?,1,'Prior AI draft','Human accepted text.',?)
                """.formatted(schema),UUID.randomUUID(),segment,actor);
            Integer v16 = jdbc.queryForObject("""
                SELECT checksum FROM %s.flyway_schema_history WHERE version='16'
                """.formatted(schema), Integer.class);
            Integer v17 = jdbc.queryForObject("""
                SELECT checksum FROM %s.flyway_schema_history WHERE version='17'
                """.formatted(schema), Integer.class);
            Flyway upgraded = latest(schema);
            upgraded.migrate();
            upgraded.validate();
            assertThat(jdbc.queryForObject("""
                SELECT checksum FROM %s.flyway_schema_history WHERE version='16'
                """.formatted(schema),Integer.class)).isEqualTo(v16);
            assertThat(jdbc.queryForObject("""
                SELECT checksum FROM %s.flyway_schema_history WHERE version='17'
                """.formatted(schema),Integer.class)).isEqualTo(v17);
            assertThat(jdbc.queryForObject("""
                SELECT content_revision FROM %s.transcripts WHERE id=? AND is_current
                  AND source_stage_run_id=? AND source_media_id=?
                """.formatted(schema), Long.class, transcript,finalizer,media)).isEqualTo(1L);
            assertThat(jdbc.queryForObject("""
                SELECT current_text FROM %s.transcript_segments WHERE id=?
                  AND source_stage_run_id=?
                """.formatted(schema), String.class, segment,upstream))
                .isEqualTo("Human accepted text.");
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.transcript_segment_revisions WHERE segment_id=?
                """.formatted(schema),Integer.class,segment)).isEqualTo(1);
        } finally {
            cleanup(schema);
        }
    }

    @Test
    void v17ExistingCrossJobSegmentCannotBeSilentlyUpgradedOrDeleted() {
        String schema = schema();
        UUID actor=UUID.randomUUID(),meeting=UUID.randomUUID(),
            media=UUID.randomUUID(),job=UUID.randomUUID(),
            stage=UUID.randomUUID(),secondJob=UUID.randomUUID(),
            secondStage=UUID.randomUUID(),transcript=UUID.randomUUID(),segment=UUID.randomUUID();
        try {
            flyway(schema,17).migrate();
            seedIdentity(schema,actor,meeting,media,job);
            jdbc.update("""
                INSERT INTO %s.processing_jobs(id,meeting_id,source_media_id,
                    requested_by_user_id,status,reprocess_of_job_id)
                VALUES (?,?,?,?,'COMPLETED',?)
                """.formatted(schema),secondJob,meeting,media,actor,job);
            stage(schema,stage,job,"FINALIZING_TRANSCRIPT");
            stage(schema,secondStage,secondJob,"TRANSCRIPTION");
            jdbc.update("""
                INSERT INTO %s.transcripts(id,meeting_id,source_media_id,processing_job_id,
                    source_stage_run_id,version_number,language_code,status)
                VALUES (?,?,?,?,?,1,'vi','READY')
                """.formatted(schema),transcript,meeting,media,job,stage);
            // Legal in V17, but cross-job provenance must be rejected by V22.
            jdbc.update("""
                INSERT INTO %s.transcript_segments(id,transcript_id,ordinal,start_ms,end_ms,
                    current_text,quality_status,source_stage_run_id)
                VALUES (?,?,0,100,1400,'Historical incorrect attribution.','ACCEPTED',?)
                """.formatted(schema),segment,transcript,secondStage);
            Flyway upgraded = latest(schema);
            assertThatThrownBy(upgraded::migrate)
                .hasMessageContaining("V22");
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.transcript_segments WHERE id=? AND source_stage_run_id=?
                """.formatted(schema),Integer.class,segment,secondStage)).isEqualTo(1);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.transcripts WHERE id=?
                """.formatted(schema),Integer.class,transcript)).isEqualTo(1);
            assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM %s.flyway_schema_history WHERE version='22' AND success
                """.formatted(schema),Integer.class)).isZero();
        } finally {
            cleanup(schema);
        }
    }
}
