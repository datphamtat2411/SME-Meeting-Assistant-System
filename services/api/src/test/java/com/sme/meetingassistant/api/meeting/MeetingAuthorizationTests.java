package com.sme.meetingassistant.api.meeting;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
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
class MeetingAuthorizationTests {

	@Autowired
	private MockMvc mockMvc;

	@Test
	void allowsOrganizerAndParticipantButHidesMeetingFromOtherUsers() throws Exception {
		UUID organizer = UUID.randomUUID();
		UUID participant = UUID.randomUUID();
		UUID stranger = UUID.randomUUID();
		String meetingUrl = this.mockMvc.perform(post("/api/v1/meetings").principal(() -> organizer.toString())
				.contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"Private planning\"}"))
			.andExpect(status().isCreated()).andReturn().getResponse().getHeader("Location");
		this.mockMvc.perform(post(meetingUrl + "/participants").principal(() -> organizer.toString())
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"userId\":\"" + participant + "\",\"role\":\"REQUIRED\"}"))
			.andExpect(status().isCreated());

		this.mockMvc.perform(get(meetingUrl).principal(() -> organizer.toString())).andExpect(status().isOk());
		this.mockMvc.perform(get(meetingUrl).principal(() -> participant.toString())).andExpect(status().isOk());
		this.mockMvc.perform(get(meetingUrl).principal(() -> stranger.toString())).andExpect(status().isNotFound());
	}

	@Test
	void doesNotTrustClientProvidedIdentityHeader() throws Exception {
		this.mockMvc.perform(post("/api/v1/meetings").header("X-User-Id", UUID.randomUUID().toString())
				.contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"Forged\"}"))
			.andExpect(status().isUnauthorized());
	}
}
