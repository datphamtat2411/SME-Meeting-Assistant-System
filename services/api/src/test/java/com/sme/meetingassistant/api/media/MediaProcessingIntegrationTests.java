package com.sme.meetingassistant.api.media;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.media.storage.ObjectStorage;
import com.sme.meetingassistant.api.media.storage.ObjectStorageProperties;
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
		assertThat(this.jdbcTemplate.queryForObject("SELECT COUNT(*) FROM processing_jobs", Integer.class)).isEqualTo(1);
		assertThat(this.jdbcTemplate.queryForObject("SELECT COUNT(*) FROM processing_job_idempotency", Integer.class))
				.isEqualTo(1);
		assertThat(this.jdbcTemplate.queryForObject("SELECT COUNT(*) FROM outbox_events", Integer.class)).isEqualTo(1);
	}

	private String createMeeting(UUID callerId) throws Exception {
		return this.mockMvc.perform(post("/api/v1/meetings").principal(() -> callerId.toString())
				.contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"Media test\"}"))
			.andExpect(status().isCreated()).andReturn().getResponse().getHeader("Location");
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
