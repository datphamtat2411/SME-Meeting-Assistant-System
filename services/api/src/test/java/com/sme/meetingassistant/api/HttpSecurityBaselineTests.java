package com.sme.meetingassistant.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.observability.RequestIdContext;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.RequestPostProcessor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import({ HttpSecurityBaselineTests.ApiController.class, PostgresTestConfiguration.class })
class HttpSecurityBaselineTests {

	private static final String ALLOWED_ORIGIN = "http://localhost:3000";
	private static final String DISALLOWED_ORIGIN = "https://untrusted.example";
	private static final String API_PATH = "/api/v1/security-test";
	private static final String ALLOWED_METHODS = "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS";
	private static final String ALLOWED_HEADERS = "Accept, Content-Type, Authorization, X-CSRF-Token, Idempotency-Key, If-Match, X-Request-Id";
	private static final String EXPOSED_HEADERS = "ETag, Location, X-Request-Id";

	@Autowired
	private MockMvc mockMvc;

	@Test
	void allowedPreflightReturnsBoundedCorsPermissionAndBaselineHeaders() throws Exception {
		this.mockMvc.perform(options(API_PATH)
				.header(HttpHeaders.ORIGIN, ALLOWED_ORIGIN)
				.header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "POST")
				.header(HttpHeaders.ACCESS_CONTROL_REQUEST_HEADERS, ALLOWED_HEADERS))
				.andExpect(status().isOk())
				.andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, ALLOWED_ORIGIN))
				.andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_METHODS, ALLOWED_METHODS))
				.andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_HEADERS, ALLOWED_HEADERS))
				.andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_CREDENTIALS, "true"))
				.andExpect(header().string(HttpHeaders.ACCESS_CONTROL_MAX_AGE, "600"))
				.andExpect(header().exists(RequestIdContext.HEADER_NAME))
				.andExpect(header().string("X-Content-Type-Options", "nosniff"))
				.andExpect(header().string("Referrer-Policy", "strict-origin-when-cross-origin"))
				.andExpect(header().string("X-Frame-Options", "DENY"))
				.andExpect(header().doesNotExist("Strict-Transport-Security"));
	}

	@Test
	void disabledHstsRemainsAbsentForDirectAndForwardedHttps() throws Exception {
		this.mockMvc.perform(get(API_PATH).secure(true).with(remoteAddress("198.51.100.10")))
				.andExpect(status().isOk())
				.andExpect(header().doesNotExist("Strict-Transport-Security"));

		this.mockMvc.perform(get(API_PATH)
					.header("X-Forwarded-Proto", "https")
					.with(remoteAddress("127.0.0.1")))
				.andExpect(status().isOk())
				.andExpect(header().doesNotExist("Strict-Transport-Security"));
	}

	@Test
	void allowedApiRequestPreservesResponseAndExposesOnlyApprovedHeaders() throws Exception {
		this.mockMvc.perform(get(API_PATH).header(HttpHeaders.ORIGIN, ALLOWED_ORIGIN))
				.andExpect(status().isOk())
				.andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, ALLOWED_ORIGIN))
				.andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_CREDENTIALS, "true"))
				.andExpect(header().string(HttpHeaders.ACCESS_CONTROL_EXPOSE_HEADERS, EXPOSED_HEADERS))
				.andExpect(header().string(HttpHeaders.ETAG, "\"v1\""))
				.andExpect(header().string(HttpHeaders.LOCATION, API_PATH))
				.andExpect(header().exists(RequestIdContext.HEADER_NAME))
				.andExpect(status().isOk());
	}

	@Test
	void disallowedOriginReceivesNoCorsPermission() throws Exception {
		MvcResult result = this.mockMvc.perform(get(API_PATH).header(HttpHeaders.ORIGIN, DISALLOWED_ORIGIN))
				.andReturn();

		assertThat(result.getResponse().getHeader(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN)).isNull();
		assertThat(result.getResponse().getHeader(RequestIdContext.HEADER_NAME)).isNotBlank();
	}

	@Test
	void disallowedPreflightMethodReceivesNoCorsPermission() throws Exception {
		MvcResult result = this.mockMvc.perform(options(API_PATH)
				.header(HttpHeaders.ORIGIN, ALLOWED_ORIGIN)
				.header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "TRACE"))
				.andReturn();

		assertThat(result.getResponse().getHeader(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN)).isNull();
	}

	@Test
	void disallowedPreflightHeaderReceivesNoCorsPermission() throws Exception {
		MvcResult result = this.mockMvc.perform(options(API_PATH)
				.header(HttpHeaders.ORIGIN, ALLOWED_ORIGIN)
				.header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "GET")
				.header(HttpHeaders.ACCESS_CONTROL_REQUEST_HEADERS, "X-Not-Allowed"))
				.andReturn();

		assertThat(result.getResponse().getHeader(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN)).isNull();
	}

	@Test
	void apiHealthAndErrorResponsesContainBaselineHeaders() throws Exception {
		assertBaselineHeaders(this.mockMvc.perform(get(API_PATH)).andExpect(status().isOk()).andReturn());
		assertBaselineHeaders(this.mockMvc.perform(get("/actuator/health/liveness"))
				.andExpect(status().isOk()).andReturn());
		assertBaselineHeaders(this.mockMvc.perform(get("/does-not-exist"))
				.andExpect(status().isNotFound()).andReturn());
	}

	private static void assertBaselineHeaders(MvcResult result) {
		assertThat(result.getResponse().getHeader("X-Content-Type-Options")).isEqualTo("nosniff");
		assertThat(result.getResponse().getHeader("Referrer-Policy"))
				.isEqualTo("strict-origin-when-cross-origin");
		assertThat(result.getResponse().getHeader("X-Frame-Options")).isEqualTo("DENY");
		assertThat(result.getResponse().getHeader("Strict-Transport-Security")).isNull();
		assertThat(result.getResponse().getHeader(RequestIdContext.HEADER_NAME)).isNotBlank();
	}

	private static RequestPostProcessor remoteAddress(String remoteAddress) {
		return request -> {
			request.setRemoteAddr(remoteAddress);
			return request;
		};
	}

	@RestController
	@RequestMapping(API_PATH)
	static class ApiController {

		@GetMapping
		ResponseEntity<String> get() {
			return ResponseEntity.ok()
					.eTag("\"v1\"")
					.header(HttpHeaders.LOCATION, API_PATH)
					.body("ok");
		}

	}

}
