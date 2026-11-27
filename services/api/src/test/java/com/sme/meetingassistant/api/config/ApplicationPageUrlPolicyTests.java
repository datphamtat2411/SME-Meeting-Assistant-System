package com.sme.meetingassistant.api.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;

import java.net.URI;
import org.junit.jupiter.api.Test;

class ApplicationPageUrlPolicyTests {

	@Test
	void developmentAllowsOnlyLoopbackHttpPages() {
		assertThat(ApplicationPageUrlPolicy.validate(
				"http://localhost:5173/account-setup", "development", "setup"))
			.isEqualTo(URI.create("http://localhost:5173/account-setup"));
		assertThat(ApplicationPageUrlPolicy.validate(
				"http://127.0.0.1:5173/password-recovery", "development", "recovery"))
			.isEqualTo(URI.create("http://127.0.0.1:5173/password-recovery"));
	}

	@Test
	void nonDevelopmentEnvironmentsRequireHttps() {
		assertThatIllegalArgumentException().isThrownBy(() ->
			ApplicationPageUrlPolicy.validate(
				"http://localhost:5173/account-setup", "test", "setup"));
		assertThat(ApplicationPageUrlPolicy.validate(
				"https://accounts.example.test/password-recovery", "production", "recovery"))
			.isEqualTo(URI.create("https://accounts.example.test/password-recovery"));
	}

	@Test
	void developmentHttpCannotTargetNonLoopbackOrCarryCredentialsAndQueries() {
		assertThatIllegalArgumentException().isThrownBy(() ->
			ApplicationPageUrlPolicy.validate(
				"http://web.internal:5173/account-setup", "development", "setup"));
		assertThatIllegalArgumentException().isThrownBy(() ->
			ApplicationPageUrlPolicy.validate(
				"http://localhost:5173/account-setup?next=unsafe", "development", "setup"));
		assertThatIllegalArgumentException().isThrownBy(() ->
			ApplicationPageUrlPolicy.validate(
				"https://user:password@example.test/account-setup", "production", "setup"));
	}
}
