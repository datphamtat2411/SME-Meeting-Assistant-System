package com.sme.meetingassistant.api.room;

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
class RoomSchemaIntegrationTests {
    @Autowired JdbcTemplate jdbc;

    @Test
    void roomSchemaIsCanonicalAndMigratedAfterExistingAuthHistory() {
        assertThat(jdbc.queryForList("""
            SELECT version FROM flyway_schema_history
             WHERE version IS NOT NULL AND success ORDER BY installed_rank
            """, String.class)).containsExactly("1", "2", "3", "4", "5", "6", "7");

        List<String> columns = jdbc.queryForList("""
            SELECT column_name FROM information_schema.columns
             WHERE table_schema='public' AND table_name='rooms'
            """, String.class);
        assertThat(columns).contains("id", "code", "name", "location", "capacity",
            "status", "notes", "created_at", "updated_at", "version");
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM pg_constraint WHERE conrelid='public.rooms'::regclass
             AND conname IN ('ux_rooms_code','ck_rooms_capacity','ck_rooms_status')
            """, Integer.class)).isEqualTo(3);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM information_schema.tables
             WHERE table_schema='public' AND table_name IN ('organizations','user_accounts')
            """, Integer.class)).isZero();
    }

    @Test
    void databaseEnforcesRoomCodeUniquenessEvenOutsideTheService() {
        String code = "U-" + UUID.randomUUID();
        jdbc.update("INSERT INTO rooms(id,code,name) VALUES (?,?,?)",
            UUID.randomUUID(), code, "Original");
        assertThatThrownBy(() -> jdbc.update("INSERT INTO rooms(id,code,name) VALUES (?,?,?)",
            UUID.randomUUID(), code, "Duplicate")).isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void databaseRejectsNonPositiveCapacity() {
        assertThatThrownBy(() -> jdbc.update("INSERT INTO rooms(id,code,name,capacity) VALUES (?,?,?,?)",
            UUID.randomUUID(), "CAP-" + UUID.randomUUID(), "Invalid", 0))
            .isInstanceOf(DataIntegrityViolationException.class);
    }
}
