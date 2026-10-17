package com.sme.meetingassistant.api.meeting;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
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
class MeetingControllerTests {

	@Autowired
	private MockMvc mockMvc;

	@Test
	void createsMeetingAndReturnsLocation() throws Exception {
		UUID callerId = UUID.randomUUID();
		this.mockMvc.perform(post("/api/v1/meetings")
				.principal(() -> callerId.toString())
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"title\":\"Planning\",\"description\":\"Sprint planning\"}"))
			.andExpect(status().isCreated())
			.andExpect(header().exists("Location"))
			.andExpect(jsonPath("$.success").value(true))
			.andExpect(jsonPath("$.data.title").value("Planning"))
			.andExpect(jsonPath("$.data.status").value("DRAFT"));
	}

	@Test
	void getsMeetingDetailWithETagAndListsWithPaginationMetadata() throws Exception {
		UUID callerId = UUID.randomUUID();
		String location = this.mockMvc.perform(post("/api/v1/meetings")
				.principal(() -> callerId.toString())
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"title\":\"Quarterly review\"}"))
			.andExpect(status().isCreated())
			.andReturn().getResponse().getHeader("Location");

		this.mockMvc.perform(get(location).principal(() -> callerId.toString()))
			.andExpect(status().isOk())
			.andExpect(header().exists("ETag"))
			.andExpect(jsonPath("$.data.title").value("Quarterly review"));

		this.mockMvc.perform(get("/api/v1/meetings?page=0&size=10&q=Quarterly")
				.principal(() -> callerId.toString()))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.meta.pagination.page").value(0))
			.andExpect(jsonPath("$.meta.pagination.totalElements").value(1));
	}

	@Test
	void rejectsCreateWithoutTitle() throws Exception {
		this.mockMvc.perform(post("/api/v1/meetings")
				.principal(() -> UUID.randomUUID().toString())
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"description\":\"Missing title\"}"))
			.andExpect(status().isUnprocessableEntity());
	}
}
