package com.sme.meetingassistant.api.notification;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.notification.dto.CreateNotificationCommand;
import com.sme.meetingassistant.api.notification.service.NotificationCommand;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class NotificationsIntegrationTests {

	@Autowired
	private MockMvc mockMvc;

	@Autowired
	private JdbcTemplate jdbcTemplate;

	@Autowired
	private NotificationCommand notificationCommand;

	@Test
	void duplicateEventDeliveryCreatesOneRecipientNotificationAndInboxIsPrivate() throws Exception {
		UUID recipientId = UUID.randomUUID();
		UUID otherRecipientId = UUID.randomUUID();
		UUID eventId = UUID.randomUUID();
		var first = create(eventId, recipientId, "ACTION_ITEM_ASSIGNED", "New task", "Please send the report.");
		var duplicate = create(eventId, recipientId, "ACTION_ITEM_ASSIGNED", "Different retry payload", "Ignored retry.");

		assertThat(duplicate.id()).isEqualTo(first.id());
		assertThat(duplicate.title()).isEqualTo("New task");
		assertThat(this.jdbcTemplate.queryForObject("SELECT COUNT(*) FROM notifications WHERE event_id = ? AND recipient_id = ?",
				Integer.class, eventId, recipientId)).isEqualTo(1);

		this.mockMvc.perform(get("/api/v1/notifications").principal(() -> recipientId.toString()))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.data.length()").value(1))
			.andExpect(jsonPath("$.data[0].title").value("New task"));
		this.mockMvc.perform(get("/api/v1/notifications/unread-count").principal(() -> recipientId.toString()))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.data.unreadCount").value(1));
		this.mockMvc.perform(get("/api/v1/notifications").principal(() -> otherRecipientId.toString()))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.data.length()").value(0));
	}

	@Test
	void recipientCanMarkOneAndAllNotificationsReadWithVersionedUpdates() throws Exception {
		UUID recipientId = UUID.randomUUID();
		var first = create(UUID.randomUUID(), recipientId, "MEETING_UPDATED", "Meeting moved", "The meeting time changed.");
		var second = create(UUID.randomUUID(), recipientId, "ACTION_ITEM_ASSIGNED", "New task", "Review the notes.");

		this.mockMvc.perform(patch("/api/v1/notifications/" + first.id() + "/read")
				.principal(() -> recipientId.toString()).header("If-Match", "\"0\""))
			.andExpect(status().isOk())
			.andExpect(header().string("ETag", "\"1\""))
			.andExpect(jsonPath("$.data.readAt").isNotEmpty());
		this.mockMvc.perform(patch("/api/v1/notifications/" + first.id() + "/read")
				.principal(() -> recipientId.toString()).header("If-Match", "\"0\""))
			.andExpect(status().isPreconditionFailed());
		this.mockMvc.perform(post("/api/v1/notifications/read-all").principal(() -> recipientId.toString()))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.data.updatedCount").value(1));
		this.mockMvc.perform(get("/api/v1/notifications/unread-count").principal(() -> recipientId.toString()))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.data.unreadCount").value(0));

		this.mockMvc.perform(patch("/api/v1/notifications/" + second.id() + "/read")
				.principal(() -> UUID.randomUUID().toString()).header("If-Match", "\"0\""))
			.andExpect(status().isNotFound());
		assertThat(this.jdbcTemplate.queryForObject("SELECT COUNT(*) FROM notifications WHERE recipient_id = ? AND read_at IS NOT NULL",
				Integer.class, recipientId)).isEqualTo(2);
	}

	private com.sme.meetingassistant.api.notification.dto.NotificationResponse create(UUID eventId, UUID recipientId,
			String type, String title, String body) {
		return this.notificationCommand.create(new CreateNotificationCommand(eventId, recipientId, type, title, body,
				"MEETING", UUID.randomUUID()));
	}

}
