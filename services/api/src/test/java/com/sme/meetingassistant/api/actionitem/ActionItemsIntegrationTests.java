package com.sme.meetingassistant.api.actionitem;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.actionitem.dto.ActionItemProposalInput;
import com.sme.meetingassistant.api.actionitem.dto.ActionItemStatus;
import com.sme.meetingassistant.api.actionitem.dto.IngestActionItemsRequest;
import com.sme.meetingassistant.api.actionitem.dto.UpdateActionItemRequest;
import com.sme.meetingassistant.api.actionitem.service.ActionItemIngestion;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.sme.meetingassistant.api.transcript.dto.TranscriptSegmentInput;
import com.sme.meetingassistant.api.transcript.service.TranscriptService;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
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
class ActionItemsIntegrationTests {

	@Autowired
	private MockMvc mockMvc;

	@Autowired
	private JdbcTemplate jdbcTemplate;

	@Autowired
	private TranscriptService transcriptService;

	@Autowired
	private ActionItemIngestion actionItemIngestion;

	@Test
	void proposedItemCanBeAssignedAndAdvancedWithHistoryAndDerivedOverdue() throws Exception {
		UUID organizerId = UUID.randomUUID();
		UUID meetingId = createMeeting(organizerId);
		var transcript = transcript(meetingId, organizerId, "Alice will send the report by yesterday.");
		var item = propose(meetingId, transcript.id(), organizerId,
				transcript.segments().getFirst().id(), LocalDate.now().minusDays(1));
		String url = "/api/v1/meetings/" + meetingId + "/action-items/" + item.id();

		this.mockMvc.perform(get("/api/v1/meetings/" + meetingId + "/action-items")
				.principal(() -> organizerId.toString()))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.data[0].status").value("PROPOSED"))
			.andExpect(jsonPath("$.data[0].overdue").value(true));

		this.mockMvc.perform(patch(url).principal(() -> organizerId.toString()).header("If-Match", "\"0\"")
				.contentType("application/json")
				.content("{\"status\":\"CONFIRMED\",\"assigneeId\":\"" + organizerId
						+ "\",\"dueDate\":\"" + LocalDate.now().minusDays(1) + "\"}"))
			.andExpect(status().isOk())
			.andExpect(header().string("ETag", "\"1\""))
			.andExpect(jsonPath("$.data.assigneeId").value(organizerId.toString()))
			.andExpect(jsonPath("$.data.status").value("CONFIRMED"));

		this.mockMvc.perform(patch(url).principal(() -> organizerId.toString()).header("If-Match", "\"0\"")
				.contentType("application/json").content("{\"status\":\"CANCELLED\"}"))
			.andExpect(status().isPreconditionFailed());

		this.mockMvc.perform(patch(url).principal(() -> organizerId.toString()).header("If-Match", "\"1\"")
				.contentType("application/json").content("{\"status\":\"COMPLETED\"}"))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.data.overdue").value(false));

		this.mockMvc.perform(get(url + "/history").principal(() -> organizerId.toString()))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.data.length()").value(2))
			.andExpect(jsonPath("$.data[1].previousStatus").value("PROPOSED"))
			.andExpect(jsonPath("$.data[1].status").value("CONFIRMED"))
			.andExpect(jsonPath("$.data[1].actorId").value(organizerId.toString()));
		assertThat(this.jdbcTemplate.queryForObject(
				"SELECT COUNT(*) FROM action_item_change_history WHERE action_item_id = ?", Integer.class, item.id()))
			.isEqualTo(2);
	}

	@Test
	void proposalRequiresAValidMeetingAssigneeAndEvidenceFromItsTranscript() throws Exception {
		UUID organizerId = UUID.randomUUID();
		UUID outsiderId = UUID.randomUUID();
		UUID meetingId = createMeeting(organizerId);
		var transcript = transcript(meetingId, organizerId, "I will prepare the budget.");
		var item = propose(meetingId, transcript.id(), organizerId, transcript.segments().getFirst().id(), null);
		var otherTranscript = transcript(meetingId, organizerId, "Another meeting detail.");

		org.assertj.core.api.Assertions.assertThatThrownBy(() -> this.actionItemIngestion.ingest(
				new IngestActionItemsRequest(meetingId, transcript.id(), List.of(new ActionItemProposalInput(
						"Prepare budget", outsiderId, null, List.of(transcript.segments().getFirst().id()))))))
			.isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
		org.assertj.core.api.Assertions.assertThatThrownBy(() -> this.actionItemIngestion.ingest(
				new IngestActionItemsRequest(meetingId, transcript.id(), List.of(new ActionItemProposalInput(
						"Prepare budget", null, null, List.of(otherTranscript.segments().getFirst().id()))))))
			.isInstanceOf(org.springframework.web.server.ResponseStatusException.class);

		this.mockMvc.perform(get("/api/v1/meetings/" + meetingId + "/action-items/" + item.id())
				.principal(() -> outsiderId.toString()))
			.andExpect(status().isNotFound());
		assertThat(this.jdbcTemplate.queryForObject("SELECT status FROM action_items WHERE id = ?", String.class,
				item.id())).isEqualTo(ActionItemStatus.PROPOSED.name());
	}

	private UUID createMeeting(UUID callerId) throws Exception {
		String location = this.mockMvc.perform(post("/api/v1/meetings").principal(() -> callerId.toString())
				.contentType("application/json").content("{\"title\":\"Action items\"}"))
			.andExpect(status().isCreated()).andReturn().getResponse().getHeader("Location");
		return UUID.fromString(location.substring(location.lastIndexOf('/') + 1));
	}

	private com.sme.meetingassistant.api.transcript.dto.TranscriptResponse transcript(UUID meetingId, UUID actorId,
			String text) {
		return this.transcriptService.ingest(meetingId, actorId, UUID.randomUUID(), "en-US",
				List.of(new TranscriptSegmentInput(1, 0, 1400, text, "Speaker A", new BigDecimal("0.96"))));
	}

	private com.sme.meetingassistant.api.actionitem.dto.ActionItemResponse propose(UUID meetingId, UUID transcriptId,
			UUID assigneeId, UUID evidenceId, LocalDate dueDate) {
		return this.actionItemIngestion.ingest(new IngestActionItemsRequest(meetingId, transcriptId,
				List.of(new ActionItemProposalInput("Send the report", assigneeId, dueDate, List.of(evidenceId)))))
				.getFirst();
	}

}
