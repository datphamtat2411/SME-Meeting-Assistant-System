package com.sme.meetingassistant.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.observability.RequestIdContext;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
@TestPropertySource(properties = {
		"app.runtime.environment=production",
		"app.http.security.cors.allowed-origins=https://app.example.com",
		"springdoc.api-docs.enabled=false",
		"springdoc.swagger-ui.enabled=false"
})
class ProductionEndpointExposureTests {

	@Autowired
	private MockMvc mockMvc;

	@Test
	void productionLivenessAndReadinessRemainAvailableWithoutDetails() throws Exception {
		assertHealthProbe("/actuator/health/liveness");
		assertHealthProbe("/actuator/health/readiness");
	}

	@Test
	void productionDiagnosticsAndDocumentationAreUnavailable() throws Exception {
		assertUnavailable("/actuator/metrics");
		assertUnavailable("/actuator/env");
		assertUnavailable("/actuator/configprops");
		assertUnavailable("/actuator/beans");
		assertUnavailable("/actuator/mappings");
		assertUnavailable("/v3/api-docs");
		assertUnavailable("/swagger-ui/index.html");
	}

	private void assertHealthProbe(String path) throws Exception {
		MvcResult result = this.mockMvc.perform(get(path))
				.andExpect(status().isOk())
				.andExpect(header().exists(RequestIdContext.HEADER_NAME))
				.andExpect(header().string("X-Content-Type-Options", "nosniff"))
				.andExpect(header().string("Referrer-Policy", "strict-origin-when-cross-origin"))
				.andExpect(header().string("X-Frame-Options", "DENY"))
				.andReturn();

		assertThat(result.getResponse().getContentAsString())
				.contains("\"status\":\"UP\"")
				.doesNotContain("\"details\"");
	}

	private void assertUnavailable(String path) throws Exception {
		this.mockMvc.perform(get(path)).andExpect(status().isNotFound());
	}

}
