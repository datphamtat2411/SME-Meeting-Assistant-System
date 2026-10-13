package com.sme.meetingassistant.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.observability.RequestIdContext;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.RequestPostProcessor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import({ HstsProxyIntegrationTests.ApiController.class, PostgresTestConfiguration.class })
@TestPropertySource(properties = {
		"app.http.security.hsts.enabled=true",
		"app.http.security.hsts.max-age=90s",
		"app.http.security.hsts.include-subdomains=false",
		"app.http.security.hsts.trusted-proxies=192.0.2.10"
})
class HstsProxyIntegrationTests {

	private static final String API_PATH = "/hsts-test/success";
	private static final String TRUSTED_PROXY = "192.0.2.10";
	private static final String UNTRUSTED_PEER = "198.51.100.10";
	private static final String HSTS = "Strict-Transport-Security";

	@Autowired
	private MockMvc mockMvc;

	@Test
	void directHttpsReceivesHstsWithoutForwardedHeaders() throws Exception {
		MvcResult result = this.mockMvc.perform(get(API_PATH)
					.secure(true)
					.with(remoteAddress(UNTRUSTED_PEER)))
				.andExpect(status().isOk())
				.andExpect(content().string("ok"))
				.andReturn();

		assertHsts(result, "max-age=90");
	}

	@Test
	void directHttpDoesNotReceiveHsts() throws Exception {
		this.mockMvc.perform(get(API_PATH).with(remoteAddress(UNTRUSTED_PEER)))
				.andExpect(status().isOk())
				.andExpect(header().doesNotExist(HSTS));
	}

	@Test
	void trustedProxyHttpsClaimReceivesHsts() throws Exception {
		MvcResult result = this.mockMvc.perform(get(API_PATH)
					.header("X-Forwarded-Proto", " HTTPS ")
					.with(remoteAddress(TRUSTED_PROXY)))
				.andExpect(status().isOk())
				.andExpect(header().exists(RequestIdContext.HEADER_NAME))
				.andReturn();

		assertHsts(result, "max-age=90");
	}

	@Test
	void trustedProxyHttpClaimDoesNotReceiveHsts() throws Exception {
		this.mockMvc.perform(get(API_PATH)
					.header("X-Forwarded-Proto", "http")
					.with(remoteAddress(TRUSTED_PROXY)))
				.andExpect(status().isOk())
				.andExpect(header().doesNotExist(HSTS));
	}

	@Test
	void untrustedPeerCannotEnableHstsWithSpoofedForwardingHeader() throws Exception {
		this.mockMvc.perform(get(API_PATH)
					.header("X-Forwarded-Proto", "https")
					.with(remoteAddress(UNTRUSTED_PEER)))
				.andExpect(status().isOk())
				.andExpect(header().doesNotExist(HSTS));
	}

	@Test
	void trustedPeerWithoutForwardedSchemeDoesNotReceiveHsts() throws Exception {
		this.mockMvc.perform(get(API_PATH).with(remoteAddress(TRUSTED_PROXY)))
				.andExpect(status().isOk())
				.andExpect(header().doesNotExist(HSTS));
	}

	@Test
	void ambiguousOrConflictingForwardedProtocolDoesNotReceiveHsts() throws Exception {
		this.mockMvc.perform(get(API_PATH)
					.header("X-Forwarded-Proto", "https,http")
					.with(remoteAddress(TRUSTED_PROXY)))
				.andExpect(status().isOk())
				.andExpect(header().doesNotExist(HSTS));

		this.mockMvc.perform(get(API_PATH)
					.header("X-Forwarded-Proto", "https", "https")
					.with(remoteAddress(TRUSTED_PROXY)))
				.andExpect(status().isOk())
				.andExpect(header().doesNotExist(HSTS));

		this.mockMvc.perform(get(API_PATH)
					.header("X-Forwarded-Proto", "https")
					.header("Forwarded", "for=192.0.2.20;proto=http")
					.with(remoteAddress(TRUSTED_PROXY)))
				.andExpect(status().isOk())
				.andExpect(header().doesNotExist(HSTS));
	}

	@Test
	void eligibleErrorAndActuatorResponsesRetainStatusBodiesAndHsts() throws Exception {
		MvcResult badRequest = this.mockMvc.perform(get("/hsts-test/bad-request")
					.header("X-Forwarded-Proto", "https")
					.with(remoteAddress(TRUSTED_PROXY)))
				.andExpect(status().isBadRequest())
				.andExpect(content().string("bad request"))
				.andReturn();
		assertHsts(badRequest, "max-age=90");

		MvcResult serverError = this.mockMvc.perform(get("/hsts-test/server-error")
					.header("X-Forwarded-Proto", "https")
					.with(remoteAddress(TRUSTED_PROXY)))
				.andExpect(status().isInternalServerError())
				.andExpect(content().string("server error"))
				.andReturn();
		assertHsts(serverError, "max-age=90");

		MvcResult notFound = this.mockMvc.perform(get("/hsts-test/not-found")
					.header("X-Forwarded-Proto", "https")
					.with(remoteAddress(TRUSTED_PROXY)))
				.andExpect(status().isNotFound())
				.andReturn();
		assertHsts(notFound, "max-age=90");

		MvcResult health = this.mockMvc.perform(get("/actuator/health/liveness")
					.header("X-Forwarded-Proto", "https")
					.with(remoteAddress(TRUSTED_PROXY)))
				.andExpect(status().isOk())
				.andExpect(content().string(org.hamcrest.Matchers.containsString("\"status\":\"UP\"")))
				.andReturn();
		assertHsts(health, "max-age=90");
	}

	@Test
	void eligibleCorsPreflightRetainsCorsHeadersAndHsts() throws Exception {
		MvcResult result = this.mockMvc.perform(options("/api/v1/hsts-preflight")
					.header(HttpHeaders.ORIGIN, "http://localhost:3000")
					.header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "GET")
					.header("X-Forwarded-Proto", "https")
					.with(remoteAddress(TRUSTED_PROXY)))
				.andExpect(status().isOk())
				.andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, "http://localhost:3000"))
				.andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_CREDENTIALS, "true"))
				.andExpect(header().exists(RequestIdContext.HEADER_NAME))
				.andReturn();

		assertHsts(result, "max-age=90");
	}

	@Test
	void hstsProxyTrustDoesNotExpandRequestIdTrust() throws Exception {
		String suppliedRequestId = UUID.randomUUID().toString();

		MvcResult result = this.mockMvc.perform(get(API_PATH)
					.header(RequestIdContext.HEADER_NAME, suppliedRequestId)
					.header("X-Forwarded-Proto", "https")
					.with(remoteAddress(TRUSTED_PROXY)))
				.andExpect(status().isOk())
				.andReturn();

		assertThat(result.getResponse().getHeader(RequestIdContext.HEADER_NAME)).isNotEqualTo(suppliedRequestId);
		assertHsts(result, "max-age=90");
	}

	private static void assertHsts(MvcResult result, String expectedValue) {
		assertThat(result.getResponse().getHeaders(HSTS)).containsExactly(expectedValue);
		assertThat(result.getResponse().getHeader("X-Content-Type-Options")).isEqualTo("nosniff");
		assertThat(result.getResponse().getHeader("Referrer-Policy"))
				.isEqualTo("strict-origin-when-cross-origin");
		assertThat(result.getResponse().getHeader("X-Frame-Options")).isEqualTo("DENY");
	}

	private static RequestPostProcessor remoteAddress(String remoteAddress) {
		return request -> {
			request.setRemoteAddr(remoteAddress);
			return request;
		};
	}

	@RestController
	@RequestMapping("/hsts-test")
	static class ApiController {

		@GetMapping("/success")
		ResponseEntity<String> success() {
			return ResponseEntity.ok("ok");
		}

		@GetMapping("/bad-request")
		ResponseEntity<String> badRequest() {
			return ResponseEntity.badRequest().body("bad request");
		}

		@GetMapping("/server-error")
		ResponseEntity<String> serverError() {
			return ResponseEntity.internalServerError().body("server error");
		}

	}

}
