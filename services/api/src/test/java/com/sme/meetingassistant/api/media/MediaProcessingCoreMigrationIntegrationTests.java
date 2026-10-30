package com.sme.meetingassistant.api.media;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sme.meetingassistant.api.media.repository.MediaRepository;
import java.util.UUID;

import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;

class MediaProcessingCoreMigrationIntegrationTests {
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:17");
    private static JdbcTemplate jdbc;

    @BeforeAll
    static void migrateCurrentSchema() {
        POSTGRES.start();
        var dataSource = new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
            POSTGRES.getUsername(), POSTGRES.getPassword());
        Flyway.configure().dataSource(dataSource).locations("classpath:db/migration").load().migrate();
        jdbc = new JdbcTemplate(dataSource);
    }

    @AfterAll
    static void stopPostgres() {
        POSTGRES.stop();
    }

    @Test
    void flywayCreatesCoreMediaJobIdempotencyAndOutboxTables() {
        assertEquals(4, jdbc.queryForObject("""
            SELECT count(*) FROM information_schema.tables
            WHERE table_schema = current_schema()
              AND table_name IN ('meeting_media', 'processing_jobs', 'processing_job_idempotency', 'outbox_events')
            """, Integer.class));
    }

    @Test
    void sourceMediaAndJobTablesKeepTheirIndependentLifecycles() {
        assertEquals(6, jdbc.queryForObject("""
            SELECT count(*) FROM information_schema.columns
            WHERE table_schema = current_schema() AND (
              (table_name = 'meeting_media' AND column_name IN ('status', 'expected_size_bytes', 'object_key')) OR
              (table_name = 'processing_jobs' AND column_name IN ('status', 'source_media_id', 'meeting_id')))
            """, Integer.class));
    }
    @Test
    void migrationAddsFinalizationFencingAndPendingObjectLineage() {
        assertEquals(4, jdbc.queryForObject("""
            SELECT count(*) FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'meeting_media'
              AND column_name IN ('pending_object_key', 'finalization_token',
                                  'finalization_lease_until', 'pending_cleaned_at')
            """, Integer.class));
    }

    @Test
    void onlyCurrentLeaseOwnerCanAcceptImmutableSource() {
        UUID userId = UUID.randomUUID();
        UUID meetingId = UUID.randomUUID();
        UUID mediaId = UUID.randomUUID();
        UUID owner = UUID.randomUUID();
        UUID competing = UUID.randomUUID();
        String pending = "meetings/" + meetingId + "/pending/" + mediaId;
        String accepted = "meetings/" + meetingId + "/sources/" + mediaId;
        jdbc.update("""
            INSERT INTO users(id, email, email_normalized, display_name)
            VALUES (?, ?, ?, 'T02 tester')
            """, userId, userId + "@example.test", userId + "@example.test");
        jdbc.update("""
            INSERT INTO meetings(id, title, organizer_user_id, created_by_user_id)
            VALUES (?, 'T02 meeting', ?, ?)
            """, meetingId, userId, userId);
        jdbc.update("""
            INSERT INTO meeting_media (id, meeting_id, source_type, status, object_key,
                  pending_object_key, original_filename, content_type, expected_size_bytes, uploaded_by_user_id)
            VALUES (?, ?, 'UPLOAD', 'PENDING_UPLOAD', ?, ?, 'recording.wav', 'audio/wav', 512, ?)
            """, mediaId, meetingId, pending, pending, userId);

        var repository = new MediaRepository(jdbc, new tools.jackson.databind.ObjectMapper());
        assertTrue(repository.claimFinalization(mediaId, owner, 1800));
        assertFalse(repository.claimFinalization(mediaId, competing, 1800));
        assertFalse(repository.acceptMedia(mediaId, competing, accepted, 512, 1000, "a".repeat(64)));
        assertTrue(repository.acceptMedia(mediaId, owner, accepted, 512, 1000, "a".repeat(64)));
        repository.releaseFinalization(mediaId, owner);
        assertFalse(repository.claimFinalization(mediaId, competing, 1800));
        var actual = repository.findMedia(mediaId).orElseThrow();
        assertEquals("AVAILABLE", actual.status());
        assertEquals(accepted, actual.objectKey());
        assertEquals(pending, jdbc.queryForObject(
            "SELECT pending_object_key FROM meeting_media WHERE id = ?", String.class, mediaId));
    }

    @Test
    void migrationV13AddsJobAdmissionInvariantsAndReprocessingProvenance() {
        assertEquals(1, jdbc.queryForObject("""
            SELECT count(*) FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'processing_jobs'
              AND column_name = 'reprocess_of_job_id'
            """, Integer.class));
        assertEquals(2, jdbc.queryForObject("""
            SELECT count(*) FROM pg_indexes
            WHERE schemaname = current_schema() AND tablename = 'processing_jobs'
              AND indexname IN ('ux_processing_jobs_active_meeting',
                                'ux_processing_jobs_initial_media')
            """, Integer.class));
    }

    @Test
    void migrationV14AddsFencedOutboxClaimColumnsAndIndex() {
        assertEquals(2, jdbc.queryForObject("""
            SELECT count(*) FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'outbox_events'
              AND column_name IN ('claim_token', 'claim_expires_at')
            """, Integer.class));
        assertEquals(1, jdbc.queryForObject("""
            SELECT count(*) FROM pg_indexes
            WHERE schemaname = current_schema() AND tablename = 'outbox_events'
              AND indexname = 'ix_outbox_events_claimable'
            """, Integer.class));
    }

}
