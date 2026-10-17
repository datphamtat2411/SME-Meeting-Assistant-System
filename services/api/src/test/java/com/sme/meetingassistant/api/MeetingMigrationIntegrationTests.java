package com.sme.meetingassistant.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.sql.SQLException;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class MeetingMigrationIntegrationTests {

	@Autowired
	private JdbcTemplate jdbcTemplate;

	@Test
	void productionMigrationCreatesMeetingTablesAndExpectedColumns() {
		assertThat(columns("meetings"))
				.contains("id", "title", "description", "status", "organizer_id", "start_time", "end_time",
						"version", "created_at", "updated_at");
		assertThat(columns("meeting_participants"))
				.contains("id", "meeting_id", "user_id", "role", "status", "created_at", "updated_at",
						"removed_at");
	}

	@Test
	void activeParticipantIsUniqueButRemovedHistoryAllowsReinvitation() {
		UUID meetingId = UUID.randomUUID();
		UUID userId = UUID.randomUUID();
		this.jdbcTemplate.update("INSERT INTO meetings (id, title, organizer_id) VALUES (?, ?, ?)",
				meetingId, "Planning", UUID.randomUUID());
		this.jdbcTemplate.update("INSERT INTO meeting_participants (meeting_id, user_id, role, status) "
				+ "VALUES (?, ?, 'REQUIRED', 'INVITED')", meetingId, userId);

		assertThatThrownBy(() -> this.jdbcTemplate.update("INSERT INTO meeting_participants "
				+ "(meeting_id, user_id, role, status) VALUES (?, ?, 'OPTIONAL', 'ACCEPTED')", meetingId, userId))
				.isInstanceOf(RuntimeException.class);

		this.jdbcTemplate.update("UPDATE meeting_participants SET status = 'REMOVED', removed_at = CURRENT_TIMESTAMP "
				+ "WHERE meeting_id = ? AND user_id = ?", meetingId, userId);
		this.jdbcTemplate.update("INSERT INTO meeting_participants (meeting_id, user_id, role, status) "
				+ "VALUES (?, ?, 'REQUIRED', 'INVITED')", meetingId, userId);

		assertThat(this.jdbcTemplate.queryForObject("SELECT COUNT(*) FROM meeting_participants "
				+ "WHERE meeting_id = ? AND user_id = ?", Integer.class, meetingId, userId)).isEqualTo(2);
	}

	@Test
	void meetingScheduleMustBeCompleteAndChronologicallyValid() {
		UUID organizerId = UUID.randomUUID();
		UUID missingEndMeetingId = UUID.randomUUID();
		assertThatThrownBy(() -> this.jdbcTemplate.update(
				"INSERT INTO meetings (id, title, organizer_id, start_time) VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
				missingEndMeetingId, "Incomplete", organizerId))
				.isInstanceOf(RuntimeException.class);

		UUID invalidRangeMeetingId = UUID.randomUUID();
		assertThatThrownBy(() -> this.jdbcTemplate.update("INSERT INTO meetings "
				+ "(id, title, organizer_id, start_time, end_time) "
				+ "VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP - INTERVAL '1 hour')",
				invalidRangeMeetingId, "Invalid range", organizerId))
				.isInstanceOf(RuntimeException.class);
	}

	private java.util.Set<String> columns(String table) {
		return java.util.Set.copyOf(this.jdbcTemplate.queryForList(
				"SELECT column_name FROM information_schema.columns "
						+ "WHERE table_schema = current_schema() AND table_name = ?", String.class, table));
	}

}
