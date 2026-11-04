package com.sme.meetingassistant.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.config.RuntimeProperties;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;

class CoreRuntimeConfigurationTests {

	private final ApplicationContextRunner contextRunner = new ApplicationContextRunner()
			.withUserConfiguration(RuntimeConfiguration.class);

	@Test
	void validRuntimePropertiesBindFromConfiguration() {
		this.contextRunner
				.withPropertyValues(
						"app.runtime.environment=test",
						"app.runtime.request-id.trusted-proxies=127.0.0.1")
				.run(context -> {
					assertThat(context).hasNotFailed();
					RuntimeProperties runtimeProperties = context.getBean(RuntimeProperties.class);
					assertThat(runtimeProperties.getEnvironment()).isEqualTo("test");
					assertThat(runtimeProperties.getRequestId().getTrustedProxies())
							.containsExactly("127.0.0.1");
				});
	}

	@Test
	void missingEnvironmentFailsStartupWithAnActionablePropertyReference() {
		this.contextRunner
				.withPropertyValues("app.runtime.environment=")
				.run(context -> {
					assertThat(context).hasFailed();
					assertThat(context.getStartupFailure())
							.hasStackTraceContaining("app.runtime.environment");
				});
	}

	@Configuration(proxyBeanMethods = false)
	@EnableConfigurationProperties(RuntimeProperties.class)
	static class RuntimeConfiguration {
	}

}
