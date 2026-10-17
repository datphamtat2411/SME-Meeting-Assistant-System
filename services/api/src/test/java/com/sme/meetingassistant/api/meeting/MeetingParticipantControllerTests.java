package com.sme.meetingassistant.api.meeting;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
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
class MeetingParticipantControllerTests {

	@Autowired
	private MockMvc mockMvc;

	@Test
	void addsListsAndRemovesParticipantWhileKeepingHistory() throws Exception {
		UUID organizer = UUID.randomUUID();
		UUID participant = UUID.randomUUID();
		String meetingUrl = createMeeting(organizer);
		String participantsUrl = meetingUrl + "/participants";
		this.mockMvc.perform(get(meetingUrl).principal(() -> organizer.toString()))
			.andExpect(status().isOk()).andExpect(header().string("ETag", "\"0\""));

		String participantLocation = this.mockMvc.perform(post(participantsUrl).principal(() -> organizer.toString())
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"userId\":\"" + participant + "\",\"role\":\"REQUIRED\"}"))
			.andExpect(status().isCreated())
			.andExpect(jsonPath("$.data.status").value("INVITED"))
			.andReturn().getResponse().getHeader("Location");
		this.mockMvc.perform(get(meetingUrl).principal(() -> organizer.toString()))
			.andExpect(status().isOk()).andExpect(header().string("ETag", "\"1\""));

		this.mockMvc.perform(get(participantsUrl).principal(() -> organizer.toString()))
			.andExpect(status().isOk()).andExpect(jsonPath("$.data[0].userId").value(participant.toString()));

		this.mockMvc.perform(delete(participantLocation).principal(() -> organizer.toString()))
			.andExpect(status().isOk()).andExpect(jsonPath("$.data.status").value("REMOVED"));
		this.mockMvc.perform(get(meetingUrl).principal(() -> organizer.toString()))
			.andExpect(status().isOk()).andExpect(header().string("ETag", "\"2\""));
		this.mockMvc.perform(get(participantsUrl).principal(() -> organizer.toString()))
			.andExpect(status().isOk()).andExpect(jsonPath("$.data[0].status").value("REMOVED"));
	}

	@Test
	void rejectsDuplicateActiveParticipant() throws Exception {
		UUID organizer = UUID.randomUUID();
		String participantsUrl = createMeeting(organizer) + "/participants";
		String request = "{\"userId\":\"" + UUID.randomUUID() + "\",\"role\":\"OPTIONAL\"}";
		this.mockMvc.perform(post(participantsUrl).principal(() -> organizer.toString())
				.contentType(MediaType.APPLICATION_JSON).content(request)).andExpect(status().isCreated());
		this.mockMvc.perform(post(participantsUrl).principal(() -> organizer.toString())
				.contentType(MediaType.APPLICATION_JSON).content(request)).andExpect(status().isConflict());
	}

	private String createMeeting(UUID caller) throws Exception {
		return this.mockMvc.perform(post("/api/v1/meetings").principal(() -> caller.toString())
				.contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"Planning\"}"))
			.andExpect(status().isCreated()).andReturn().getResponse().getHeader("Location");
	}
}
