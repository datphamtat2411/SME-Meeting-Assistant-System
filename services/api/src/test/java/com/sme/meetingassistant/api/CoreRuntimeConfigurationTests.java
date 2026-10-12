package com.sme.meetingassistant.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.config.RuntimeProperties;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

@SpringBootTest
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
				.withUserConfiguration(MeetingAssistantApiApplication.class)
				.withPropertyValues("app.runtime.environment=")
				.run(context -> {
					assertThat(context).hasFailed();
					assertThat(context.getStartupFailure())
							.hasStackTraceContaining("app.runtime.environment");
				});
	}

}
