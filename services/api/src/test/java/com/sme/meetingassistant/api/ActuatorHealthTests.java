package com.sme.meetingassistant.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.observability.RequestIdContext;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

@SpringBootTest
@AutoConfigureMockMvc
class ActuatorHealthTests {

	@Autowired
	private MockMvc mockMvc;

	@Test
	void livenessIsAPlainActuatorResponseWithOnlyLivenessState() throws Exception {
		MvcResult result = this.mockMvc.perform(get("/actuator/health/liveness"))
				.andExpect(status().isOk())
				.andExpect(header().exists(RequestIdContext.HEADER_NAME))
				.andReturn();

		String body = result.getResponse().getContentAsString();
		assertThat(body).contains("\"status\":\"UP\"").doesNotContain("\"meta\"");
		assertOnlyComponent(body, "livenessState", "readinessState");
	}

	@Test
	void readinessIsAPlainActuatorResponseWithOnlyReadinessState() throws Exception {
		MvcResult result = this.mockMvc.perform(get("/actuator/health/readiness"))
				.andExpect(status().isOk())
				.andExpect(header().exists(RequestIdContext.HEADER_NAME))
				.andReturn();

		String body = result.getResponse().getContentAsString();
		assertThat(body).contains("\"status\":\"UP\"").doesNotContain("\"meta\"");
		assertOnlyComponent(body, "readinessState", "livenessState");
	}

	private static void assertOnlyComponent(String body, String expectedComponent, String excludedComponent) {
		if (body.contains("\"components\"")) {
			assertThat(body).contains("\"" + expectedComponent + "\"")
					.doesNotContain("\"" + excludedComponent + "\"");
		}
	}

}
