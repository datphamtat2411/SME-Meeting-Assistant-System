package com.sme.meetingassistant.api.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

/** PR #3/#4-only consolidated Flyway chain; exercised on PostgreSQL 17. */
@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class CompactAuthFlywayBaselineIntegrationTests {
    @Autowired JdbcTemplate jdbc;

    @Test
    void canonicalAuthMigrationsRemainFirstFourAndRoomCatalogIsFifth() {
        List<String> versions = jdbc.queryForList("""
            SELECT version FROM flyway_schema_history
            WHERE success AND version IS NOT NULL ORDER BY installed_rank
            """,String.class);
        assertThat(versions).containsExactly("1","2","3","4","5","6","7","8");
        assertThat(jdbc.queryForList("""
            SELECT script FROM flyway_schema_history WHERE success
             AND version IS NOT NULL ORDER BY installed_rank
            """,String.class)).containsExactly(
                "V1__create_canonical_identity_and_organizational_units.sql",
                "V2__account_setup_and_email_delivery.sql",
                "V3__authentication_sessions_and_recovery.sql",
                "V4__authentication_security_controls.sql",
                "V5__create_canonical_room_catalog.sql",
                "V6__create_canonical_meeting_core.sql",
                "V7__create_canonical_room_reservations.sql",
                "V8__meeting_notification_supersession.sql");
    }

    @Test
    void recoveryNonceAndConstraintsExistInTheInitialTokenSchema() {
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM information_schema.columns
             WHERE table_schema='public' AND table_name='password_reset_tokens'
               AND column_name='delivery_nonce' AND data_type='bytea'
            """,Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM pg_constraint
             WHERE conrelid='public.password_reset_tokens'::regclass
               AND conname='ck_password_reset_nonce'
            """,Integer.class)).isEqualTo(1);
        // The historical V22 added the same (user_id, requested_at DESC)
        // index twice under two names. The compact baseline retains one.
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM pg_indexes
             WHERE schemaname='public' AND tablename='password_reset_tokens'
               AND indexname IN
                 ('ix_password_reset_tokens_user_requested','ix_recovery_token_user_window')
            """,Integer.class)).isEqualTo(1);
    }

    @Test
    void securityTablesShareOneMigrationWithoutLosingAuditOrRateLimitControls() {
        List<String> actual = jdbc.queryForList("""
            SELECT table_name FROM information_schema.tables
             WHERE table_schema='public' AND table_name IN
               ('audit_events','recovery_ip_limits','auth_abuse_attempts',
                'auth_login_failure_backoff')
             ORDER BY table_name
            """,String.class);
        assertThat(actual).containsExactly("audit_events","auth_abuse_attempts",
            "auth_login_failure_backoff","recovery_ip_limits");
    }
}
