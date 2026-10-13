package com.sme.meetingassistant.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.config.RuntimeProperties;
import com.sme.meetingassistant.api.support.PostgresTestConfiguration;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;

@ActiveProfiles("test")
@SpringBootTest
@Import(PostgresTestConfiguration.class)
class CoreRuntimeConfigurationTests {

	@Autowired
	private RuntimeProperties runtimeProperties;

	@Test
	void validRuntimePropertiesBindFromConfiguration() {
		assertThat(this.runtimeProperties.getEnvironment()).isEqualTo("test");
		assertThat(this.runtimeProperties.getRequestId().getTrustedProxies())
				.containsExactly("127.0.0.1");
	}

	@Test
	void missingEnvironmentFailsStartupWithAnActionablePropertyReference() {
		new ApplicationContextRunner()
				.withUserConfiguration(MeetingAssistantApiApplication.class, PostgresTestConfiguration.class)
				.withPropertyValues("app.runtime.environment=")
				.run(context -> {
					assertThat(context).hasFailed();
					assertThat(context.getStartupFailure())
							.hasStackTraceContaining("app.runtime.environment");
				});
	}

}
