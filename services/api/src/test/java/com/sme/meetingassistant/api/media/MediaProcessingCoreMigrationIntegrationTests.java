package com.sme.meetingassistant.api.media;

import static org.junit.jupiter.api.Assertions.assertEquals;

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
}
