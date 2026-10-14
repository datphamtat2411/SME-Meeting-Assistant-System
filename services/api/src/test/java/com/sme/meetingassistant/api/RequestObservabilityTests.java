package com.sme.meetingassistant.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.observability.RequestIdContext;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.RequestPostProcessor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.server.ResponseStatusException;

import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;

@ActiveProfiles("test")
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
				.doesNotContain("\"event\":\"api.http_500\"")
				.doesNotContain(sensitiveContent);
	}

	@Test
	void unexpectedHttp500EmitsOneSafeDiagnosticWithCanonicalCorrelation(CapturedOutput output) throws Exception {
		String suppliedRequestId = UUID.randomUUID().toString();
		String before = output.getOut();

		MvcResult result = this.mockMvc.perform(get("/test/unexpected")
				.header(RequestIdContext.HEADER_NAME, suppliedRequestId)
				.with(remoteAddress(TRUSTED_REMOTE_ADDRESS)))
				.andExpect(status().isInternalServerError())
				.andExpect(header().string(RequestIdContext.HEADER_NAME, suppliedRequestId))
				.andReturn();

		assertThat(result.getResponse().getContentAsString())
				.doesNotContain("password=private-secret", "private-token", "confidential-meeting", "IllegalStateException");
		String logs = outputSince(output, before);
		assertThat(countOccurrences(logs, "\"event\":\"api.http_500\"")).isEqualTo(1);
		assertThat(logs)
				.contains("\"level\":\"ERROR\"")
				.contains("\"event\":\"api.http_500\"")
				.contains("\"status\":500")
				.contains("\"errorCode\":\"INTERNAL_ERROR\"")
				.contains("\"exceptionType\":\"java.lang.IllegalStateException\"")
				.contains("\"rootCauseType\":\"java.lang.IllegalStateException\"")
				.contains("\"failureLocation\":\"com.sme.meetingassistant.api.")
				.contains("\"requestId\":\"" + suppliedRequestId + "\"")
				.contains("\"message\":\"HTTP 500 exception handled\"")
				.contains("\"message\":\"HTTP request completed\"")
				.doesNotContain("private-secret", "private-token", "confidential-meeting", "\"stack_trace\"", "\"throwable\"");
	}

	@Test
	void nestedExceptionsRecordTheRootCauseWithoutRecordingCauseMessages(CapturedOutput output) throws Exception {
		String before = output.getOut();

		this.mockMvc.perform(get("/test/nested"))
				.andExpect(status().isInternalServerError());

		String logs = outputSince(output, before);
		assertThat(countOccurrences(logs, "\"event\":\"api.http_500\"")).isEqualTo(1);
		assertThat(logs)
				.contains("\"exceptionType\":\"java.lang.IllegalStateException\"")
				.contains("\"rootCauseType\":\"java.lang.IllegalArgumentException\"")
				.doesNotContain("outer failure details", "root failure details", "\"stack_trace\"");
	}

	@Test
	void explicitHttp500ExceptionsEmitOneSanitizedDiagnostic(CapturedOutput output) throws Exception {
		String before = output.getOut();

		this.mockMvc.perform(get("/test/http-500"))
				.andExpect(status().isInternalServerError());

		String logs = outputSince(output, before);
		assertThat(countOccurrences(logs, "\"event\":\"api.http_500\"")).isEqualTo(1);
		assertThat(logs)
				.contains("\"exceptionType\":\"org.springframework.web.server.ResponseStatusException\"")
				.contains("\"rootCauseType\":\"org.springframework.web.server.ResponseStatusException\"")
				.doesNotContain("framework exception details", "\"stack_trace\"");
	}

	@Test
	void returnValueValidationFailuresRemainInternalErrorsAndEmitOneDiagnostic(CapturedOutput output) throws Exception {
		String before = output.getOut();

		MvcResult result = this.mockMvc.perform(get("/test/invalid-return"))
				.andExpect(status().isInternalServerError())
				.andReturn();

		assertThat(result.getResponse().getContentAsString())
				.contains("\"code\":\"INTERNAL_ERROR\"")
				.contains("An unexpected error occurred.")
				.doesNotContain("NotNull", "invalid return value");
		String logs = outputSince(output, before);
		assertThat(countOccurrences(logs, "\"event\":\"api.http_500\"")).isEqualTo(1);
		assertThat(logs)
				.contains("\"exceptionType\":\"org.springframework.web.method.annotation.HandlerMethodValidationException\"")
				.doesNotContain("NotNull", "invalid return value", "\"stack_trace\"");
	}

	@Test
	void ordinaryClientErrorsKeepCompletionLogsWithoutHttp500Diagnostics(CapturedOutput output) throws Exception {
		String before = output.getOut();

		this.mockMvc.perform(post("/test/validated-body")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{"))
				.andExpect(status().isBadRequest());
		this.mockMvc.perform(get("/test/integer").param("value", "not-an-integer"))
				.andExpect(status().isBadRequest());
		this.mockMvc.perform(get("/test/validated-parameter").param("value", ""))
				.andExpect(status().isUnprocessableEntity());
		this.mockMvc.perform(get("/test/missing"))
				.andExpect(status().isNotFound());

		String logs = outputSince(output, before);
		assertThat(countOccurrences(logs, "\"event\":\"api.http_500\"")).isZero();
		assertThat(logs).contains("\"message\":\"HTTP request completed\"");
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

	private static String outputSince(CapturedOutput output, String before) {
		String current = output.getOut();
		return current.startsWith(before) ? current.substring(before.length()) : current;
	}

	private static int countOccurrences(String value, String token) {
		int count = 0;
		int offset = 0;
		while ((offset = value.indexOf(token, offset)) >= 0) {
			count++;
			offset += token.length();
		}
		return count;
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

		@GetMapping("/test/unexpected")
		String unexpected() {
			throw new IllegalStateException(
					"password=private-secret; token=private-token; transcript=confidential-meeting");
		}

		@GetMapping("/test/nested")
		String nested() {
			throw new IllegalStateException("outer failure details",
					new IllegalArgumentException("root failure details"));
		}

		@GetMapping("/test/http-500")
		String http500() {
			throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "framework exception details");
		}

		@GetMapping("/test/invalid-return")
		@NotNull
		String invalidReturn() {
			return null;
		}

		@PostMapping("/test/validated-body")
		String validatedBody(@Valid @RequestBody BodyRequest request) {
			return request.value();
		}

		@GetMapping("/test/integer")
		String integer(@RequestParam int value) {
			return Integer.toString(value);
		}

		@GetMapping("/test/validated-parameter")
		String validatedParameter(@RequestParam(defaultValue = "") @NotBlank String value) {
			return value;
		}

		@GetMapping("/test/missing")
		String missing() {
			throw new ResponseStatusException(HttpStatus.NOT_FOUND, "sensitive missing resource detail");
		}

		@PostMapping("/test/body")
		String body(@RequestBody String ignoredBody) {
			return "accepted";
		}

	}

	record BodyRequest(@NotBlank String value) {
	}

}
