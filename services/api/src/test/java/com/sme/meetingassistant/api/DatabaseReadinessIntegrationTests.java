package com.sme.meetingassistant.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.observability.RequestIdContext;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import com.zaxxer.hikari.HikariDataSource;
import java.time.Duration;
import java.util.Map;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Import;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.testcontainers.containers.PostgreSQLContainer;

@ActiveProfiles("test")
@SpringBootTest(properties = {
		"spring.datasource.hikari.connection-timeout=1000",
		"spring.datasource.hikari.validation-timeout=250",
		"spring.datasource.hikari.minimum-idle=0"
})
@AutoConfigureMockMvc
@Import(PostgresTestConfiguration.class)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class DatabaseReadinessIntegrationTests {

	private static final Duration READINESS_TRANSITION_DEADLINE = Duration.ofSeconds(10);

	@Autowired
	private MockMvc mockMvc;

	@Autowired
	private ApplicationContext applicationContext;

	@Autowired
	private DataSource dataSource;

	@Autowired
	private PostgreSQLContainer<?> postgresContainer;

	@Test
	void databaseOutageMakesReadinessUnavailableWithoutAffectingLiveness() throws Exception {
		Map<String, PostgreSQLContainer> postgresContainers =
				this.applicationContext.getBeansOfType(PostgreSQLContainer.class);
		assertThat(postgresContainers).hasSize(1);
		assertThat(postgresContainers.values().iterator().next()).isSameAs(this.postgresContainer);
		assertThat(this.dataSource).isInstanceOf(HikariDataSource.class);
		assertThat(((HikariDataSource) this.dataSource).getJdbcUrl()).isEqualTo(this.postgresContainer.getJdbcUrl());

		assertHealth("/actuator/health/readiness", 200, "UP");
		assertHealth("/actuator/health/liveness", 200, "UP");

		this.postgresContainer.stop();

		MvcResult unhealthyReadiness = awaitReadinessDown();
		assertThat(unhealthyReadiness.getResponse().getContentAsString())
				.contains("\"status\":\"DOWN\"")
				.doesNotContain("\"success\"", "\"code\"", "\"data\"", "\"meta\"", "\"details\"",
						"\"components\"", "jdbc:", "Connection refused", "PSQLException", "org.postgresql",
						"password", "username", "stackTrace");
		assertHealth("/actuator/health/liveness", 200, "UP");
	}

	private void assertHealth(String path, int expectedStatus, String expectedHealth) throws Exception {
		this.mockMvc.perform(get(path))
				.andExpect(status().is(expectedStatus))
				.andExpect(header().exists(RequestIdContext.HEADER_NAME))
				.andExpect(header().string("X-Content-Type-Options", "nosniff"))
				.andExpect(header().string("Referrer-Policy", "strict-origin-when-cross-origin"))
				.andExpect(header().string("X-Frame-Options", "DENY"))
				.andExpect(jsonPath("$.status").value(expectedHealth));
	}

	private MvcResult awaitReadinessDown() throws Exception {
		long deadline = System.nanoTime() + READINESS_TRANSITION_DEADLINE.toNanos();
		MvcResult lastResult = null;
		while (System.nanoTime() < deadline) {
			lastResult = this.mockMvc.perform(get("/actuator/health/readiness")).andReturn();
			if (lastResult.getResponse().getStatus() == 503
					&& lastResult.getResponse().getContentAsString().contains("\"status\":\"DOWN\"")) {
				return lastResult;
			}
			Thread.sleep(100);
		}

		assertThat(lastResult).as("readiness should become DOWN before the deadline").isNotNull();
		assertThat(lastResult.getResponse().getStatus()).isEqualTo(503);
		return lastResult;
	}
}
