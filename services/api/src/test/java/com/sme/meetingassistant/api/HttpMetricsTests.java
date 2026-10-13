package com.sme.meetingassistant.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import({ HttpMetricsTests.MetricsController.class, PostgresTestConfiguration.class })
class HttpMetricsTests {

	@Autowired
	private MockMvc mockMvc;

	@Autowired
	private MeterRegistry meterRegistry;

	@Test
	void successfulRequestsRecordCountLatencyStatusAndOutcome() throws Exception {
		this.mockMvc.perform(get("/test-metrics/success"))
				.andExpect(status().isOk());

		Timer timer = this.meterRegistry.find("http.server.requests")
				.tags("method", "GET", "uri", "/test-metrics/success", "status", "200", "outcome", "SUCCESS")
				.timer();

		assertThat(timer).isNotNull();
		assertThat(timer.count()).isGreaterThan(0);
		assertThat(timer.totalTime(TimeUnit.NANOSECONDS)).isGreaterThan(0);
		assertThat(timer.max(TimeUnit.NANOSECONDS)).isGreaterThan(0);
	}

	@Test
	void failedResponsesRecordErrorStatusAndOutcome() throws Exception {
		this.mockMvc.perform(get("/test-metrics/failure"))
				.andExpect(status().isInternalServerError());

		Timer timer = this.meterRegistry.find("http.server.requests")
				.tags("method", "GET", "uri", "/test-metrics/failure", "status", "500", "outcome", "SERVER_ERROR")
				.timer();

		assertThat(timer).isNotNull();
		assertThat(timer.count()).isGreaterThan(0);
	}

	@RestController
	static class MetricsController {

		@GetMapping("/test-metrics/success")
		String success() {
			return "ok";
		}

		@GetMapping("/test-metrics/failure")
		String failure(jakarta.servlet.http.HttpServletResponse response) {
			response.setStatus(500);
			return "failure";
		}

	}

}
