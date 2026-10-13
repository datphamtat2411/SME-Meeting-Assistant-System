package com.sme.meetingassistant.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.observability.RequestIdContext;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.health.actuate.endpoint.HealthEndpointGroups;
import org.springframework.boot.health.registry.HealthContributorRegistry;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
class ActuatorHealthTests {

	@Autowired
	private MockMvc mockMvc;

	@Autowired
	private HealthContributorRegistry healthContributorRegistry;

	@Autowired
	private HealthEndpointGroups healthEndpointGroups;

	@Test
	void livenessIsAPlainActuatorResponseAndRemainsDatabaseIndependent() throws Exception {
		String requestId = UUID.randomUUID().toString();
		MvcResult result = this.mockMvc.perform(get("/actuator/health/liveness")
				.header(RequestIdContext.HEADER_NAME, requestId))
				.andExpect(status().isOk())
				.andExpect(header().string(RequestIdContext.HEADER_NAME, requestId))
				.andExpect(jsonPath("$.status").value("UP"))
				.andReturn();

		String body = result.getResponse().getContentAsString();
		assertThat(body)
				.contains("\"status\":\"UP\"")
				.doesNotContain("\"success\"", "\"code\"", "\"data\"", "\"meta\"");
		assertThat(this.healthEndpointGroups.get("liveness").isMember("livenessState")).isTrue();
		assertThat(this.healthEndpointGroups.get("liveness").isMember("readinessState")).isFalse();
		assertThat(this.healthEndpointGroups.get("liveness").isMember("db")).isFalse();
	}

	@Test
	void readinessIsAPlainActuatorResponseWithDatabaseHealthContributor() throws Exception {
		String requestId = UUID.randomUUID().toString();
		MvcResult result = this.mockMvc.perform(get("/actuator/health/readiness")
				.header(RequestIdContext.HEADER_NAME, requestId))
				.andExpect(status().isOk())
				.andExpect(header().string(RequestIdContext.HEADER_NAME, requestId))
				.andExpect(jsonPath("$.status").value("UP"))
				.andReturn();

		String body = result.getResponse().getContentAsString();
		assertThat(body)
				.contains("\"status\":\"UP\"")
				.doesNotContain("\"success\"", "\"code\"", "\"data\"", "\"meta\"");
		assertThat(this.healthContributorRegistry.getContributor("db")).isNotNull();
		assertThat(this.healthEndpointGroups.get("readiness").isMember("readinessState")).isTrue();
		assertThat(this.healthEndpointGroups.get("readiness").isMember("db")).isTrue();
		assertThat(this.healthEndpointGroups.get("readiness").isMember("livenessState")).isFalse();
	}

}
