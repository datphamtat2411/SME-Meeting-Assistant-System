package com.sme.meetingassistant.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.observability.RequestIdContext;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.RequestPostProcessor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;

@SpringBootTest
@AutoConfigureMockMvc
@Import({ RequestObservabilityTests.TestController.class, PostgresTestConfiguration.class })
@ExtendWith(OutputCaptureExtension.class)
class RequestObservabilityTests {

	private static final String TRUSTED_REMOTE_ADDRESS = "127.0.0.1";
	private static final String UNTRUSTED_REMOTE_ADDRESS = "192.0.2.10";

	@Autowired
	private MockMvc mockMvc;

	@Test
	void missingRequestIdIsReplacedWithACanonicalUuid() throws Exception {
		MvcResult result = this.mockMvc.perform(get("/test/ok").with(remoteAddress(TRUSTED_REMOTE_ADDRESS)))
				.andExpect(status().isOk())
				.andExpect(header().exists(RequestIdContext.HEADER_NAME))
				.andReturn();

		String requestId = result.getResponse().getHeader(RequestIdContext.HEADER_NAME);
		assertCanonicalUuid(requestId);
		assertThat(result.getResponse().getContentAsString()).isEqualTo(requestId);
	}

	@Test
	void malformedRequestIdIsReplaced() throws Exception {
		MvcResult result = this.mockMvc.perform(get("/test/ok")
					.header(RequestIdContext.HEADER_NAME, "not-a-uuid")
					.with(remoteAddress(TRUSTED_REMOTE_ADDRESS)))
				.andExpect(status().isOk())
				.andReturn();

		String requestId = result.getResponse().getHeader(RequestIdContext.HEADER_NAME);
		assertCanonicalUuid(requestId);
		assertThat(requestId).isNotEqualTo("not-a-uuid");
	}

	@Test
	void validRequestIdFromAnUntrustedPeerIsReplaced() throws Exception {
		String suppliedRequestId = UUID.randomUUID().toString();

		MvcResult result = this.mockMvc.perform(get("/test/ok")
					.header(RequestIdContext.HEADER_NAME, suppliedRequestId)
					.with(remoteAddress(UNTRUSTED_REMOTE_ADDRESS)))
				.andExpect(status().isOk())
				.andReturn();

		String requestId = result.getResponse().getHeader(RequestIdContext.HEADER_NAME);
		assertCanonicalUuid(requestId);
		assertThat(requestId).isNotEqualTo(suppliedRequestId);
	}

	@Test
	void validRequestIdFromTrustedPeerIsPreservedInContextAndResponse() throws Exception {
		String suppliedRequestId = UUID.randomUUID().toString();

		MvcResult result = this.mockMvc.perform(get("/test/ok")
					.header(RequestIdContext.HEADER_NAME, suppliedRequestId)
					.with(remoteAddress(TRUSTED_REMOTE_ADDRESS)))
				.andExpect(status().isOk())
				.andExpect(header().string(RequestIdContext.HEADER_NAME, suppliedRequestId))
				.andExpect(content().string(suppliedRequestId))
				.andReturn();

		assertThat(result.getResponse().getHeader(RequestIdContext.HEADER_NAME)).isEqualTo(suppliedRequestId);
	}

	@Test
	void failedRequestReturnsTheSameCanonicalRequestId() throws Exception {
		String suppliedRequestId = UUID.randomUUID().toString();

		this.mockMvc.perform(get("/test/failure")
					.header(RequestIdContext.HEADER_NAME, suppliedRequestId)
					.with(remoteAddress(TRUSTED_REMOTE_ADDRESS)))
				.andExpect(status().isInternalServerError())
				.andExpect(header().string(RequestIdContext.HEADER_NAME, suppliedRequestId));
	}

	@Test
	void mdcContextIsRestoredAfterRequestCompletion() throws Exception {
		MDC.put(RequestIdContext.MDC_KEY, "outer-request");

		try {
			this.mockMvc.perform(get("/test/ok").with(remoteAddress(TRUSTED_REMOTE_ADDRESS)))
					.andExpect(status().isOk());

			assertThat(MDC.get(RequestIdContext.MDC_KEY)).isEqualTo("outer-request");
		}
		finally {
			MDC.remove(RequestIdContext.MDC_KEY);
		}
	}

	@Test
	void completionLogsContainSafeRequestFieldsOnly(CapturedOutput output) throws Exception {
		String sensitiveContent = "raw meeting transcript and bearer secret";
		String suppliedRequestId = UUID.randomUUID().toString();

		this.mockMvc.perform(post("/test/body")
					.header(RequestIdContext.HEADER_NAME, suppliedRequestId)
					.contentType(MediaType.TEXT_PLAIN)
					.content(sensitiveContent)
					.with(remoteAddress(TRUSTED_REMOTE_ADDRESS)))
				.andExpect(status().isOk());

		assertThat(output)
				.contains("\"requestId\":\"" + suppliedRequestId + "\"")
				.contains("\"method\":\"POST\"")
				.contains("\"route\":\"/test/body\"")
				.contains("\"status\":200")
				.contains("\"outcome\":\"SUCCESS\"")
				.doesNotContain(sensitiveContent);
	}

	private static RequestPostProcessor remoteAddress(String remoteAddress) {
		return request -> {
			request.setRemoteAddr(remoteAddress);
			return request;
		};
	}

	private static void assertCanonicalUuid(String requestId) {
		assertThat(requestId).isNotNull();
		assertThat(UUID.fromString(requestId).toString()).isEqualTo(requestId);
	}

	@RestController
	static class TestController {

		@GetMapping("/test/ok")
		String ok() {
			return RequestIdContext.currentRequestId();
		}

		@GetMapping("/test/failure")
		ResponseEntity<String> failure() {
			return ResponseEntity.internalServerError().body("failure");
		}

		@PostMapping("/test/body")
		String body(@RequestBody String ignoredBody) {
			return "accepted";
		}

	}

}
