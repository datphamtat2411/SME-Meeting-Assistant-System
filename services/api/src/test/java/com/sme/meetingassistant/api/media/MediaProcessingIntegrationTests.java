package com.sme.meetingassistant.api.media;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.media.storage.ObjectStorageProperties;
import com.sme.meetingassistant.api.media.service.ProcessingArtifactService;
import com.sme.meetingassistant.api.media.service.ProcessingJobExecutionService;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.io.InputStream;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import jakarta.validation.Validation;
import jakarta.validation.ValidatorFactory;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import({PostgresTestConfiguration.class, MediaProcessingIntegrationTests.StorageTestConfiguration.class})
class MediaProcessingIntegrationTests {

	@Autowired
	private MockMvc mockMvc;

	@Autowired
	private JdbcTemplate jdbcTemplate;

	@Autowired
	private InMemoryObjectStorage objectStorage;

	@Autowired
	private ProcessingJobExecutionService jobExecutionService;

	@Autowired
	private ProcessingArtifactService artifactService;

	@Test
	void migrationCreatesMediaJobIdempotencyAndOutboxSchema() {
		assertThat(columns("meeting_media")).contains("meeting_id", "object_key", "size_bytes", "availability_status");
		assertThat(columns("processing_jobs")).contains("media_id", "status", "version");
		assertThat(columns("processing_job_idempotency")).contains("requester_id", "idempotency_key", "job_id");
		assertThat(columns("outbox_events")).contains("aggregate_id", "event_type", "payload", "next_attempt_at");
	}

	@Test
	void storageCredentialsAreRequiredOnlyWhenStorageIsEnabled() {
		ObjectStorageProperties properties = new ObjectStorageProperties();
		try (ValidatorFactory factory = Validation.buildDefaultValidatorFactory()) {
			var validator = factory.getValidator();
			assertThat(validator.validate(properties)).isEmpty();

			properties.setEnabled(true);
			assertThat(validator.validate(properties)).isNotEmpty();
		}
	}

	@Test
	void uploadsValidAudioAndRejectsUnsupportedAudio() throws Exception {
		UUID callerId = UUID.randomUUID();
		String meetingUrl = createMeeting(callerId);
		UUID meetingId = UUID.fromString(meetingUrl.substring(meetingUrl.lastIndexOf('/') + 1));
		MockMultipartFile validMp3 = new MockMultipartFile("file", "standup.mp3", "audio/mpeg",
				new byte[] { 'I', 'D', '3', 1, 2, 3 });

		this.mockMvc.perform(multipart(meetingUrl + "/media").file(validMp3)
				.principal(() -> callerId.toString()))
			.andExpect(status().isCreated())
			.andExpect(header().exists("Location"))
			.andExpect(jsonPath("$.success").value(true))
			.andExpect(jsonPath("$.data.fileName").value("standup.mp3"));
		assertThat(this.jdbcTemplate.queryForObject("SELECT COUNT(*) FROM meeting_media WHERE meeting_id = ?",
				Integer.class, meetingId)).isEqualTo(1);
		assertThat(this.objectStorage.objects.keySet().stream().filter(key -> key.startsWith(meetingId + "/")))
				.hasSize(1);

		MockMultipartFile invalid = new MockMultipartFile("file", "notes.txt", MediaType.TEXT_PLAIN_VALUE,
				"not audio".getBytes());
		this.mockMvc.perform(multipart(meetingUrl + "/media").file(invalid).principal(() -> callerId.toString()))
			.andExpect(status().isUnsupportedMediaType());
		assertThat(this.jdbcTemplate.queryForObject("SELECT COUNT(*) FROM meeting_media WHERE meeting_id = ?",
				Integer.class, meetingId)).isEqualTo(1);
	}

	@Test
	void processingJobAdmissionIsAcceptedAndIdempotentWithSingleOutboxEvent() throws Exception {
		UUID callerId = UUID.randomUUID();
		String meetingUrl = createMeeting(callerId);
		MockMultipartFile audio = new MockMultipartFile("file", "standup.mp3", "audio/mpeg",
				new byte[] { 'I', 'D', '3', 1, 2, 3 });
		String mediaLocation = this.mockMvc.perform(multipart(meetingUrl + "/media").file(audio)
				.principal(() -> callerId.toString()))
			.andExpect(status().isCreated()).andReturn().getResponse().getHeader("Location");
		String mediaId = mediaLocation.substring(mediaLocation.lastIndexOf('/') + 1);
		String jobUrl = meetingUrl + "/media/" + mediaId + "/processing-jobs";

		String firstJobLocation = this.mockMvc.perform(post(jobUrl).principal(() -> callerId.toString())
				.header("Idempotency-Key", "request-123"))
			.andExpect(status().isAccepted())
			.andExpect(header().exists("Location"))
			.andExpect(jsonPath("$.data.status").value("QUEUED"))
			.andReturn().getResponse().getHeader("Location");
		String secondJobLocation = this.mockMvc.perform(post(jobUrl).principal(() -> callerId.toString())
				.header("Idempotency-Key", "request-123"))
			.andExpect(status().isAccepted())
			.andReturn().getResponse().getHeader("Location");

		assertThat(secondJobLocation).isEqualTo(firstJobLocation);
		UUID jobId = UUID.fromString(firstJobLocation.substring(firstJobLocation.lastIndexOf('/') + 1));
		assertThat(this.jdbcTemplate.queryForObject("SELECT COUNT(*) FROM processing_jobs WHERE id = ?", Integer.class,
				jobId)).isEqualTo(1);
		assertThat(this.jdbcTemplate.queryForObject("SELECT COUNT(*) FROM processing_job_idempotency WHERE job_id = ?",
				Integer.class, jobId)).isEqualTo(1);
		assertThat(this.jdbcTemplate.queryForObject("SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = ?",
				Integer.class, jobId)).isEqualTo(1);
	}

	@Test
	void migrationCreatesProcessingAttemptArtifactAndRetrySchema() {
		assertThat(columns("processing_jobs")).contains("max_attempts", "next_attempt_at", "parent_job_id",
				"request_type");
		assertThat(columns("processing_job_attempts")).contains("job_id", "attempt_number", "status", "failure_code");
		assertThat(columns("processing_artifacts")).contains("job_id", "attempt_id", "artifact_type", "object_key",
				"size_bytes");
		assertThat(columns("processing_job_command_idempotency")).contains("requester_id", "idempotency_key",
				"job_id", "command_type");
	}

	@Test
	void retryCreatesOneExecutionRequestForFailedJobAndIsIdempotent() throws Exception {
		UUID callerId = UUID.randomUUID();
		UUID jobId = createJob(callerId);
		var attempt = this.jobExecutionService.startAttempt(jobId);
		this.jobExecutionService.failAttempt(jobId, attempt.id(), "TEMPORARY_FAILURE", false);

		String url = "/api/v1/processing-jobs/" + jobId + "/retry";
		this.mockMvc.perform(post(url).principal(() -> callerId.toString())
				.header("Idempotency-Key", "retry-once"))
			.andExpect(status().isAccepted())
			.andExpect(jsonPath("$.data.id").value(jobId.toString()))
			.andExpect(jsonPath("$.data.status").value("QUEUED"))
			.andReturn();

		this.mockMvc.perform(post(url).principal(() -> callerId.toString())
				.header("Idempotency-Key", "retry-once"))
			.andExpect(status().isAccepted())
			.andExpect(jsonPath("$.data.id").value(jobId.toString()))
			.andExpect(jsonPath("$.data.status").value("QUEUED"));

		assertThat(this.jdbcTemplate.queryForObject("SELECT status FROM processing_jobs WHERE id = ?", String.class,
				jobId)).isEqualTo("QUEUED");
		assertThat(this.jdbcTemplate.queryForObject(
				"SELECT COUNT(*) FROM processing_job_command_idempotency WHERE requester_id = ? AND idempotency_key = ?",
				Integer.class, callerId, "retry-once")).isEqualTo(1);
		assertThat(this.jdbcTemplate.queryForObject(
				"SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = ? AND event_type = ?", Integer.class, jobId,
				"processing.job.retry.requested.v1")).isEqualTo(1);
	}

	@Test
	void reprocessCreatesLinkedJobAndPreviousArtifactsRemainAvailable() throws Exception {
		UUID callerId = UUID.randomUUID();
		UUID originalJobId = createJob(callerId);
		var attempt = this.jobExecutionService.startAttempt(originalJobId);
		this.jobExecutionService.completeAttempt(originalJobId, attempt.id());
		var artifact = this.artifactService.registerArtifact(originalJobId, attempt.id(), "TRANSCRIPT",
				"transcript.json", "application/json", "meetings/transcript-1.json", 128L, "sha256:abc123");

		String url = "/api/v1/processing-jobs/" + originalJobId + "/reprocess";
		this.mockMvc.perform(post(url).principal(() -> callerId.toString())
				.header("Idempotency-Key", "reprocess-once"))
			.andExpect(status().isAccepted())
			.andExpect(jsonPath("$.data.id").isNotEmpty())
			.andExpect(jsonPath("$.data.parentJobId").value(originalJobId.toString()))
			.andReturn();
		String createdJobId = this.jdbcTemplate.queryForObject("SELECT id::text FROM processing_jobs WHERE parent_job_id = ?",
				String.class, originalJobId);
		assertThat(createdJobId).isNotEqualTo(originalJobId.toString());

		this.mockMvc.perform(get("/api/v1/processing-jobs/" + originalJobId + "/artifacts")
				.principal(() -> callerId.toString()))
			.andExpect(status().isOk())
			.andExpect(jsonPath("$.data[0].id").value(artifact.id().toString()))
			.andExpect(jsonPath("$.data[0].artifactType").value("TRANSCRIPT"))
			.andExpect(jsonPath("$.data[0].objectKey").doesNotExist());

		this.mockMvc.perform(post(url).principal(() -> callerId.toString())
				.header("Idempotency-Key", "reprocess-once"))
			.andExpect(status().isAccepted())
			.andExpect(jsonPath("$.data.id").value(createdJobId));
		assertThat(this.jdbcTemplate.queryForObject("SELECT COUNT(*) FROM processing_jobs WHERE parent_job_id = ?",
				Integer.class, originalJobId)).isEqualTo(1);
		assertThat(this.jdbcTemplate.queryForObject("SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = ?",
				Integer.class, UUID.fromString(createdJobId))).isEqualTo(1);
	}

	@Test
	void retryableFailuresAreRetriedUpToTheConfiguredAttemptLimit() throws Exception {
		UUID callerId = UUID.randomUUID();
		UUID jobId = createJob(callerId);
		var first = this.jobExecutionService.startAttempt(jobId);
		this.jobExecutionService.failAttempt(jobId, first.id(), "TEMPORARY_FAILURE", true);
		assertThat(jobStatus(jobId)).isEqualTo("QUEUED");
		assertThat(this.jdbcTemplate.queryForObject("SELECT next_attempt_at IS NOT NULL FROM processing_jobs WHERE id = ?",
				Boolean.class, jobId)).isTrue();
		this.jdbcTemplate.update("UPDATE processing_jobs SET next_attempt_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = ?",
				jobId);

		var second = this.jobExecutionService.startAttempt(jobId);
		this.jobExecutionService.failAttempt(jobId, second.id(), "TEMPORARY_FAILURE", true);
		this.jdbcTemplate.update("UPDATE processing_jobs SET next_attempt_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = ?",
				jobId);
		var third = this.jobExecutionService.startAttempt(jobId);
		this.jobExecutionService.failAttempt(jobId, third.id(), "TEMPORARY_FAILURE", true);

		assertThat(jobStatus(jobId)).isEqualTo("FAILED");
		assertThat(this.jdbcTemplate.queryForObject("SELECT attempt_count FROM processing_jobs WHERE id = ?", Integer.class,
				jobId)).isEqualTo(3);
		assertThat(this.jdbcTemplate.queryForObject("SELECT COUNT(*) FROM processing_job_attempts WHERE job_id = ?",
				Integer.class, jobId)).isEqualTo(3);
	}

	private String createMeeting(UUID callerId) throws Exception {
		return this.mockMvc.perform(post("/api/v1/meetings").principal(() -> callerId.toString())
				.contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"Media test\"}"))
			.andExpect(status().isCreated()).andReturn().getResponse().getHeader("Location");
	}

	private UUID createJob(UUID callerId) throws Exception {
		String meetingUrl = createMeeting(callerId);
		MockMultipartFile audio = new MockMultipartFile("file", "standup.mp3", "audio/mpeg",
				new byte[] { 'I', 'D', '3', 1, 2, 3 });
		String mediaLocation = this.mockMvc.perform(multipart(meetingUrl + "/media").file(audio)
				.principal(() -> callerId.toString()))
			.andExpect(status().isCreated()).andReturn().getResponse().getHeader("Location");
		String mediaId = mediaLocation.substring(mediaLocation.lastIndexOf('/') + 1);
		String meetingId = meetingUrl.substring(meetingUrl.lastIndexOf('/') + 1);
		String location = this.mockMvc.perform(post("/api/v1/meetings/" + meetingId + "/media/" + mediaId
				+ "/processing-jobs").principal(() -> callerId.toString())
				.header("Idempotency-Key", "initial-" + UUID.randomUUID()))
			.andExpect(status().isAccepted()).andReturn().getResponse().getHeader("Location");
		return UUID.fromString(location.substring(location.lastIndexOf('/') + 1));
	}

	private String jobStatus(UUID jobId) {
		return this.jdbcTemplate.queryForObject("SELECT status FROM processing_jobs WHERE id = ?", String.class, jobId);
	}

	private java.util.Set<String> columns(String table) {
		return java.util.Set.copyOf(this.jdbcTemplate.queryForList("SELECT column_name FROM information_schema.columns "
				+ "WHERE table_schema = current_schema() AND table_name = ?", String.class, table));
	}

	@TestConfiguration(proxyBeanMethods = false)
	static class StorageTestConfiguration {
		@Bean
		InMemoryObjectStorage objectStorage() {
			return new InMemoryObjectStorage();
		}
	}

	static class InMemoryObjectStorage implements ObjectStorage {
		private final ConcurrentHashMap<String, byte[]> objects = new ConcurrentHashMap<>();

		@Override
		public void store(String objectKey, InputStream content, long size, String contentType) {
			try {
				this.objects.put(objectKey, content.readAllBytes());
			}
			catch (java.io.IOException exception) {
				throw new IllegalStateException(exception);
			}
		}

		@Override
		public void delete(String objectKey) {
			this.objects.remove(objectKey);
		}
	}
}
