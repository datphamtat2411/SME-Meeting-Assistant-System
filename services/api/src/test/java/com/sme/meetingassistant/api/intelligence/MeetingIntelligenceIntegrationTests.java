package com.sme.meetingassistant.api.intelligence;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.intelligence.dto.DecisionProposalInput;
import com.sme.meetingassistant.api.intelligence.dto.IngestMeetingIntelligenceRequest;
import com.sme.meetingassistant.api.intelligence.dto.MeetingDecisionStatus;
import com.sme.meetingassistant.api.intelligence.service.MeetingIntelligenceIngestion;
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
class MeetingIntelligenceIntegrationTests {

	@Autowired
	private MockMvc mockMvc;

	@Autowired
	private JdbcTemplate jdbcTemplate;

	@Autowired
	private TranscriptService transcriptService;

	@Autowired
	private MeetingIntelligenceIngestion ingestion;

	@Test
	void ingestionCreatesCurrentSummaryVersionAndPreservesHistory() throws Exception {
		UUID callerId = UUID.randomUUID();
		UUID meetingId = createMeeting(callerId);
		var transcript = transcript(meetingId, callerId, "The team agreed to ship in June.");
		var first = ingest(meetingId, transcript.id(), "Project update", "The team discussed launch timing.",
				List.of("Launch planned for June."), List.of());
		var second = ingest(meetingId, transcript.id(), "Project update", "The team confirmed a June launch.",
				List.of("Launch planned for June."), List.of());

		assertThat(second.versionNumber()).isEqualTo(first.versionNumber() + 1);
		assertThat(this.jdbcTemplate.queryForObject("SELECT is_current FROM meeting_summaries WHERE id = ?",
				Boolean.class, first.id())).isFalse();
		this.mockMvc.perform(get("/api/v1/meetings/" + meetingId + "/intelligence/summaries/current")
				.principal(() -> callerId.toString()))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.data.id").value(second.id().toString()))
			.andExpect(jsonPath("$.data.versionNumber").value(2))
			.andExpect(jsonPath("$.data.overview").value("The team confirmed a June launch."));
		this.mockMvc.perform(get("/api/v1/meetings/" + meetingId + "/intelligence/summaries")
				.principal(() -> callerId.toString()))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.data.length()").value(2));
	}

	@Test
	void decisionReviewUsesEtagAndKeepsAppendOnlyAttribution() throws Exception {
		UUID callerId = UUID.randomUUID();
		UUID meetingId = createMeeting(callerId);
		var transcript = transcript(meetingId, callerId, "We will deliver the report by Friday.");
		var decision = ingest(meetingId, transcript.id(), "Weekly update", "The team made a commitment.", List.of(),
				List.of(new DecisionProposalInput("Deliver the report by Friday.",
						List.of(transcript.segments().getFirst().id()), new BigDecimal("0.92"))))
				.decisions().getFirst();
		String url = "/api/v1/meetings/" + meetingId + "/intelligence/decisions/" + decision.id();

		this.mockMvc.perform(patch(url).principal(() -> callerId.toString()).header("If-Match", "\"0\"")
				.contentType(MediaType.APPLICATION_JSON).content("{\"status\":\"CONFIRMED\"}"))
			.andExpect(status().isOk())
			.andExpect(header().string("ETag", "\"1\""))
			.andExpect(jsonPath("$.data.status").value("CONFIRMED"));
		this.mockMvc.perform(patch(url).principal(() -> callerId.toString()).header("If-Match", "\"0\"")
				.contentType(MediaType.APPLICATION_JSON).content("{\"status\":\"REJECTED\"}"))
			.andExpect(status().isPreconditionFailed());
		this.mockMvc.perform(get(url + "/history").principal(() -> callerId.toString()))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.data[0].previousStatus").value("PROPOSED"))
			.andExpect(jsonPath("$.data[0].status").value("CONFIRMED"))
			.andExpect(jsonPath("$.data[0].actorId").value(callerId.toString()));
		assertThat(this.jdbcTemplate.queryForObject(
				"SELECT COUNT(*) FROM meeting_decision_status_history WHERE decision_id = ?", Integer.class,
				decision.id())).isEqualTo(1);
	}

	@Test
	void intelligenceReadsAreMeetingScopedAndEvidenceMustBelongToSourceTranscript() throws Exception {
		UUID callerId = UUID.randomUUID();
		UUID outsiderId = UUID.randomUUID();
		UUID meetingId = createMeeting(callerId);
		var transcript = transcript(meetingId, callerId, "The team approved the proposal.");
		var otherTranscript = transcript(meetingId, callerId, "A separate discussion.");
		var decision = ingest(meetingId, transcript.id(), "Decision review", "Summary", List.of(),
				List.of(new DecisionProposalInput("Approve the proposal.",
						List.of(transcript.segments().getFirst().id()), null))).decisions().getFirst();
		this.mockMvc.perform(get("/api/v1/meetings/" + meetingId + "/intelligence/decisions")
				.principal(() -> outsiderId.toString()))
			.andExpect(status().isNotFound());
		org.assertj.core.api.Assertions.assertThatThrownBy(() -> ingest(meetingId, transcript.id(), "Invalid",
				"Summary", List.of(), List.of(new DecisionProposalInput("Invalid evidence.",
						List.of(otherTranscript.segments().getFirst().id()), null))))
			.isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
		assertThat(this.jdbcTemplate.queryForObject("SELECT status FROM meeting_decisions WHERE id = ?", String.class,
				decision.id())).isEqualTo(MeetingDecisionStatus.PROPOSED.name());
	}

	private UUID createMeeting(UUID callerId) throws Exception {
		String location = this.mockMvc.perform(post("/api/v1/meetings").principal(() -> callerId.toString())
				.contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"Meeting intelligence\"}"))
			.andExpect(status().isCreated()).andReturn().getResponse().getHeader("Location");
		return UUID.fromString(location.substring(location.lastIndexOf('/') + 1));
	}

	private com.sme.meetingassistant.api.transcript.dto.TranscriptResponse transcript(UUID meetingId, UUID actorId,
			String text) {
		return this.transcriptService.ingest(meetingId, actorId, UUID.randomUUID(), "en-US",
				List.of(new TranscriptSegmentInput(1, 0, 1500, text, "Speaker A", new BigDecimal("0.98"))));
	}

	private com.sme.meetingassistant.api.intelligence.dto.MeetingSummaryResponse ingest(UUID meetingId, UUID transcriptId,
			String title, String overview, List<String> keyPoints, List<DecisionProposalInput> decisions) {
		return this.ingestion.ingest(new IngestMeetingIntelligenceRequest(meetingId, transcriptId, title, overview,
				keyPoints, decisions));
	}

}
