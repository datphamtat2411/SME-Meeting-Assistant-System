package com.sme.meetingassistant.api.meeting;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
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
class MeetingConcurrencyTests {

	@Autowired
	private MockMvc mockMvc;

	@Test
	void requiresIfMatchForPatch() throws Exception {
		UUID caller = UUID.randomUUID();
		String location = createMeeting(caller);
		this.mockMvc.perform(patch(location).principal(() -> caller.toString())
				.contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"Updated\"}"))
			.andExpect(status().isPreconditionFailed());
	}

	@Test
	void updatesMeetingAndAdvancesEtagWhenIfMatchIsCurrent() throws Exception {
		UUID caller = UUID.randomUUID();
		String location = createMeeting(caller);
		this.mockMvc.perform(patch(location).principal(() -> caller.toString()).header("If-Match", "\"0\"")
				.contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"Updated\"}"))
			.andExpect(status().isOk())
			.andExpect(header().string("ETag", "\"1\""))
			.andExpect(jsonPath("$.data.title").value("Updated"));
	}

	@Test
	void rejectsStaleIfMatch() throws Exception {
		UUID caller = UUID.randomUUID();
		String location = createMeeting(caller);
		this.mockMvc.perform(patch(location).principal(() -> caller.toString()).header("If-Match", "\"9\"")
				.contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"Updated\"}"))
			.andExpect(status().isPreconditionFailed());
	}

	private String createMeeting(UUID caller) throws Exception {
		return this.mockMvc.perform(post("/api/v1/meetings").principal(() -> caller.toString())
				.contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"Planning\"}"))
			.andExpect(status().isCreated()).andReturn().getResponse().getHeader("Location");
	}
}
