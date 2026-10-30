package com.sme.meetingassistant.api.meeting;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.annotation.Transactional;

@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
@Transactional
class MeetingSchemaIntegrationTests {
    @Autowired JdbcTemplate jdbc;

    @Test void meetingAndParticipantTablesHaveCanonicalColumnsAndForeignKeys() {
        List<String> versions=jdbc.queryForList("""
            SELECT version FROM flyway_schema_history
            WHERE success AND version IS NOT NULL ORDER BY installed_rank
            """,String.class);
        assertThat(versions).containsExactly("1","2","3","4","5","6","7","8","9","10","11","12","13","14");
        List<String> cols=jdbc.queryForList("""
            SELECT column_name FROM information_schema.columns WHERE table_name='meetings'
            """,String.class);
        assertThat(cols).contains("organizer_user_id","created_by_user_id","room_id",
            "scheduled_start_at","scheduled_end_at","started_at","ended_at",
            "cancelled_at","cancellation_reason","version");
        assertThat(cols).doesNotContain("organizer_id","start_time","end_time","organization_id");
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM pg_constraint WHERE conrelid='public.meetings'::regclass
                AND contype='f'
            """,Integer.class)).isEqualTo(3);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM pg_indexes WHERE tablename='meeting_participants'
              AND indexname='ux_meeting_participants_active_user'
            """,Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM information_schema.columns
             WHERE table_name='meeting_participants' AND column_name IN ('role','status')
            """,Integer.class)).isZero();
    }

    @Test void databaseRejectsInvalidMeetingWithoutActiveApplicationValidation() {
        UUID actor=UUID.randomUUID();
        assertThatThrownBy(() -> jdbc.update("""
            INSERT INTO meetings(id,title,organizer_user_id,created_by_user_id,status)
            VALUES (?,?,?,?, 'SCHEDULED')
            """,UUID.randomUUID(),"Blank",actor,actor))
            .isInstanceOf(DataIntegrityViolationException.class);
    }
}
