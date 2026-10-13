package com.sme.meetingassistant.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.sme.meetingassistant.api.config.HttpSecurityConfiguration;
import com.sme.meetingassistant.api.config.HttpSecurityProperties;
import com.sme.meetingassistant.api.config.RuntimeProperties;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.web.filter.CorsFilter;

class HttpSecurityConfigurationTests {

	private final ApplicationContextRunner contextRunner = new ApplicationContextRunner()
			.withUserConfiguration(SecurityConfiguration.class);

	@Test
	void validNonProductionConfigurationCreatesCorsAndHeaderFilters() {
		this.contextRunner
				.withPropertyValues(
						"app.runtime.environment=test",
						"app.http.security.cors.allowed-origins=http://localhost:3000")
				.run(context -> {
					assertThat(context).hasNotFailed();
					assertThat(context).hasSingleBean(CorsFilter.class);
					assertThat(context).hasSingleBean(com.sme.meetingassistant.api.config.SecurityHeadersFilter.class);
				});
	}

	@Test
	void productionRequiresAnExplicitHttpsOrigin() {
		this.contextRunner
				.withPropertyValues(
						"app.runtime.environment=production",
						"app.http.security.cors.allowed-origins=")
				.run(context -> {
					assertThat(context).hasFailed();
					assertThat(context.getStartupFailure())
							.hasStackTraceContaining("app.http.security.cors.allowed-origins");
				});
	}

	@Test
	void productionRejectsLocalAndNonHttpsOrigins() {
		this.contextRunner
				.withPropertyValues(
						"app.runtime.environment=prod",
						"app.http.security.cors.allowed-origins=http://localhost:3000")
				.run(context -> {
					assertThat(context).hasFailed();
					assertThat(context.getStartupFailure()).hasStackTraceContaining("production-like");
				});
	}

	@Test
	void wildcardOriginsMethodsAndHeadersAreRejected() {
		assertInvalidCorsProperty("app.http.security.cors.allowed-origins", "*");
		assertInvalidCorsProperty("app.http.security.cors.allowed-methods", "GET,*");
		assertInvalidCorsProperty("app.http.security.cors.allowed-headers", "Accept,*");
	}

	@Test
	void malformedOriginIsRejected() {
		assertInvalidCorsProperty("app.http.security.cors.allowed-origins", "not-an-origin");
	}

	@Test
	void credentialedCorsRequiresAnExplicitOriginList() {
		this.contextRunner
				.withPropertyValues(
						"app.runtime.environment=test",
						"app.http.security.cors.allow-credentials=true",
						"app.http.security.cors.allowed-origins=")
				.run(context -> {
					assertThat(context).hasFailed();
					assertThat(context.getStartupFailure()).hasStackTraceContaining("credentials");
				});
	}

	private void assertInvalidCorsProperty(String property, String value) {
		this.contextRunner
				.withPropertyValues(
						"app.runtime.environment=test",
						"app.http.security.cors.allowed-origins=http://localhost:3000",
						property + "=" + value)
				.run(context -> {
					assertThat(context).hasFailed();
					assertThat(context.getStartupFailure()).hasStackTraceContaining(property);
				});
	}

	@Configuration(proxyBeanMethods = false)
	@EnableConfigurationProperties({ RuntimeProperties.class, HttpSecurityProperties.class })
	@Import(HttpSecurityConfiguration.class)
	static class SecurityConfiguration {
	}

}
