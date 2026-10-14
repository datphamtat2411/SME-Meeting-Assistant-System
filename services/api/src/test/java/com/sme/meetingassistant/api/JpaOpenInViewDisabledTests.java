package com.sme.meetingassistant.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import jakarta.persistence.EntityManagerFactory;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.core.env.Environment;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@ActiveProfiles("test")
@SpringBootTest
@AutoConfigureMockMvc
@Import({ JpaOpenInViewDisabledTests.PersistenceController.class, PostgresTestConfiguration.class })
class JpaOpenInViewDisabledTests {

	@Autowired
	private Environment environment;

	@Autowired
	private MockMvc mockMvc;

	@Test
	void productionConfigurationDisablesJpaOpenSessionInView() {
		assertThat(this.environment.getProperty("spring.jpa.open-in-view", Boolean.class)).isFalse();
	}

	@Test
	void ordinaryHttpRequestHasNoImplicitRequestScopedEntityManager() throws Exception {
		assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();

		this.mockMvc.perform(get("/test/osiv-state"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.entityManagerResourceBound").value(false))
				.andExpect(jsonPath("$.transactionSynchronizationActive").value(false))
				.andExpect(jsonPath("$.actualTransactionActive").value(false));
	}

	@RestController
	static class PersistenceController {

		private final EntityManagerFactory entityManagerFactory;

		PersistenceController(EntityManagerFactory entityManagerFactory) {
			this.entityManagerFactory = entityManagerFactory;
		}

		@GetMapping("/test/osiv-state")
		PersistenceState state() {
			return new PersistenceState(
					TransactionSynchronizationManager.hasResource(this.entityManagerFactory),
					TransactionSynchronizationManager.isSynchronizationActive(),
					TransactionSynchronizationManager.isActualTransactionActive());
		}

	}

	record PersistenceState(boolean entityManagerResourceBound, boolean transactionSynchronizationActive,
			boolean actualTransactionActive) {
	}

}
