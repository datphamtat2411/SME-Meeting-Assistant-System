package com.sme.meetingassistant.api.transcript;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.transcript.dto.TranscriptSegmentInput;
import com.sme.meetingassistant.api.transcript.service.TranscriptService;
import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class TranscriptReviewIntegrationTests {

	@Autowired
	private MockMvc mockMvc;

	@Autowired
	private JdbcTemplate jdbcTemplate;

	@Autowired
	private TranscriptService transcriptService;

	@Test
	void editorCanCorrectSegmentAndHistoryKeepsAttributionWithEtagConcurrency() throws Exception {
		UUID callerId = UUID.randomUUID();
		UUID meetingId = createMeeting(callerId);
		var transcript = ingest(meetingId, callerId, UUID.randomUUID(), "en-US", "Hello there.");
		var segment = transcript.segments().getFirst();
		String url = "/api/v1/meetings/" + meetingId + "/transcripts/" + transcript.id() + "/segments/"
				+ segment.id();

		this.mockMvc.perform(get("/api/v1/meetings/" + meetingId + "/transcripts/current")
				.principal(() -> callerId.toString()))
			.andExpect(status().isOk())
			.andExpect(header().string("ETag", "\"0\""))
			.andExpect(jsonPath("$.data.segments[0].text").value("Hello there."));

		this.mockMvc.perform(patch(url).principal(() -> callerId.toString())
				.header("If-Match", "\"0\"").contentType(MediaType.APPLICATION_JSON)
				.content("{\"text\":\"Hello, everyone.\",\"speakerLabel\":\"Speaker A\"}"))
			.andExpect(status().isOk())
			.andExpect(header().string("ETag", "\"1\""))
			.andExpect(jsonPath("$.data.text").value("Hello, everyone."));

		this.mockMvc.perform(patch(url).principal(() -> callerId.toString())
				.header("If-Match", "\"0\"").contentType(MediaType.APPLICATION_JSON)
				.content("{\"text\":\"Stale edit.\",\"speakerLabel\":\"Speaker A\"}"))
			.andExpect(status().isPreconditionFailed());

		this.mockMvc.perform(get(url + "/revisions").principal(() -> callerId.toString()))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.data[0].previousText").value("Hello there."))
			.andExpect(jsonPath("$.data[0].newText").value("Hello, everyone."))
			.andExpect(jsonPath("$.data[0].editorId").value(callerId.toString()));

		assertThat(this.jdbcTemplate.queryForObject(
				"SELECT COUNT(*) FROM transcript_segment_revisions WHERE segment_id = ?", Integer.class, segment.id()))
			.isEqualTo(1);
	}

	@Test
	void newIngestionCreatesCurrentVersionAndPreservesPreviousTranscript() throws Exception {
		UUID callerId = UUID.randomUUID();
		UUID meetingId = createMeeting(callerId);
		var first = ingest(meetingId, callerId, UUID.randomUUID(), "en-US", "First result.");
		var second = ingest(meetingId, callerId, UUID.randomUUID(), "en-US", "Second result.");

		assertThat(second.versionNumber()).isEqualTo(first.versionNumber() + 1);
		assertThat(this.jdbcTemplate.queryForObject("SELECT is_current FROM meeting_transcripts WHERE id = ?",
				Boolean.class, first.id())).isFalse();

		this.mockMvc.perform(get("/api/v1/meetings/" + meetingId + "/transcripts/current")
				.principal(() -> callerId.toString()))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.data.id").value(second.id().toString()))
			.andExpect(jsonPath("$.data.versionNumber").value(2))
			.andExpect(jsonPath("$.data.segments[0].text").value("Second result."));

		this.mockMvc.perform(get("/api/v1/meetings/" + meetingId + "/transcripts")
				.principal(() -> callerId.toString()))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.data.length()").value(2));
	}

	@Test
	void transcriptReadsRequireMeetingAccessAndMissingCurrentTranscriptIsNotFound() throws Exception {
		UUID organizerId = UUID.randomUUID();
		UUID outsiderId = UUID.randomUUID();
		UUID meetingId = createMeeting(organizerId);

		this.mockMvc.perform(get("/api/v1/meetings/" + meetingId + "/transcripts/current")
				.principal(() -> organizerId.toString()))
			.andExpect(status().isNotFound());

		var transcript = ingest(meetingId, organizerId, UUID.randomUUID(), "en-US", "Private transcript.");
		this.mockMvc.perform(get("/api/v1/meetings/" + meetingId + "/transcripts/" + transcript.id())
				.principal(() -> outsiderId.toString()))
			.andExpect(status().isNotFound());
	}

	private UUID createMeeting(UUID callerId) throws Exception {
		String location = this.mockMvc.perform(post("/api/v1/meetings").principal(() -> callerId.toString())
				.contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"Transcript review\"}"))
			.andExpect(status().isCreated()).andReturn().getResponse().getHeader("Location");
		return UUID.fromString(location.substring(location.lastIndexOf('/') + 1));
	}

	private com.sme.meetingassistant.api.transcript.dto.TranscriptResponse ingest(UUID meetingId, UUID actorId,
			UUID sourceJobId, String language, String text) {
		return this.transcriptService.ingest(meetingId, actorId, sourceJobId, language,
				List.of(new TranscriptSegmentInput(1, 0, 1500, text, "Speaker A", new BigDecimal("0.98"))));
	}

}
