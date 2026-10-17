package com.sme.meetingassistant.api.meeting;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class MeetingLifecycleTests {

	@Autowired
	private MockMvc mockMvc;

	@Test
	void transitionsFromDraftToScheduledInProgressAndEnded() throws Exception {
		UUID caller = UUID.randomUUID();
		String meetingUrl = createMeeting(caller);
		OffsetDateTime start = OffsetDateTime.now(ZoneOffset.UTC).plusDays(1).withNano(0);
		OffsetDateTime end = start.plusHours(1);
		String body = "{\"startTime\":\"" + start + "\",\"endTime\":\"" + end + "\"}";

		this.mockMvc.perform(post(meetingUrl + "/schedule").principal(() -> caller.toString())
				.contentType(MediaType.APPLICATION_JSON).content(body))
			.andExpect(status().isOk()).andExpect(jsonPath("$.data.status").value("SCHEDULED"));
		this.mockMvc.perform(post(meetingUrl + "/start").principal(() -> caller.toString()))
			.andExpect(status().isOk()).andExpect(jsonPath("$.data.status").value("IN_PROGRESS"));
		this.mockMvc.perform(post(meetingUrl + "/end").principal(() -> caller.toString()))
			.andExpect(status().isOk()).andExpect(jsonPath("$.data.status").value("ENDED"));
	}

	@Test
	void rejectsInvalidTransitionsAndCancelsDraftWithoutDeletingIt() throws Exception {
		UUID caller = UUID.randomUUID();
		String meetingUrl = createMeeting(caller);
		this.mockMvc.perform(post(meetingUrl + "/start").principal(() -> caller.toString()))
			.andExpect(status().isConflict());
		this.mockMvc.perform(post(meetingUrl + "/cancel").principal(() -> caller.toString()))
			.andExpect(status().isOk()).andExpect(jsonPath("$.data.status").value("CANCELLED"));
		this.mockMvc.perform(post(meetingUrl + "/schedule").principal(() -> caller.toString())
				.contentType(MediaType.APPLICATION_JSON).content(schedulePayload()))
			.andExpect(status().isConflict());
	}

	private String schedulePayload() {
		OffsetDateTime start = OffsetDateTime.now(ZoneOffset.UTC).plusDays(1).withNano(0);
		return "{\"startTime\":\"" + start + "\",\"endTime\":\"" + start.plusHours(1) + "\"}";
	}

	private String createMeeting(UUID caller) throws Exception {
		return this.mockMvc.perform(post("/api/v1/meetings").principal(() -> caller.toString())
				.contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"Planning\"}"))
			.andExpect(status().isCreated()).andReturn().getResponse().getHeader("Location");
	}
}
