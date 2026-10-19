package com.sme.meetingassistant.api.authentication.config;

import com.nimbusds.jose.jwk.source.ImmutableSecret;
import com.sme.meetingassistant.api.userorganization.entity.UserAccountStatus;
import com.sme.meetingassistant.api.userorganization.repository.UserAccountRepository;
import java.util.Base64;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.ProviderManager;
import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;
import org.springframework.security.web.SecurityFilterChain;

@Configuration(proxyBeanMethods = false)
public class AuthenticationSecurityConfiguration {

	@Bean
	PasswordEncoder passwordEncoder() {
		return new BCryptPasswordEncoder(12);
	}

	@Bean
	UserDetailsService userDetailsService(UserAccountRepository users) {
		return email -> users.findByNormalizedEmail(email.trim().toLowerCase(java.util.Locale.ROOT))
				.filter(account -> account.getStatus() == UserAccountStatus.ACTIVE)
				.map(account -> User.withUsername(account.getNormalizedEmail())
						.password(account.getPasswordHash())
						.authorities("ROLE_USER")
						.build())
				.orElseThrow(() -> new UsernameNotFoundException("Invalid credentials"));
	}

	@Bean
	AuthenticationManager authenticationManager(UserDetailsService users, PasswordEncoder encoder) {
		DaoAuthenticationProvider provider = new DaoAuthenticationProvider(users);
		provider.setPasswordEncoder(encoder);
		return new ProviderManager(provider);
	}

	@Bean
	SecretKey jwtSecretKey(@Value("${app.auth.jwt.secret:}") String encodedSecret) {
		if (encodedSecret == null || encodedSecret.isBlank()) {
			throw new IllegalStateException("APP_AUTH_JWT_SECRET must be configured before authentication is enabled.");
		}
		final byte[] key;
		try {
			key = Base64.getDecoder().decode(encodedSecret);
		}
		catch (IllegalArgumentException exception) {
			throw new IllegalStateException("APP_AUTH_JWT_SECRET must be Base64.", exception);
		}
		if (key.length < 32) {
			throw new IllegalStateException("APP_AUTH_JWT_SECRET must contain at least 256 bits.");
		}
		return new SecretKeySpec(key, "HmacSHA256");
	}

	@Bean
	JwtEncoder jwtEncoder(SecretKey jwtSecretKey) {
		return new NimbusJwtEncoder(new ImmutableSecret<>(jwtSecretKey));
	}

	@Bean
	JwtDecoder jwtDecoder(SecretKey jwtSecretKey) {
		return NimbusJwtDecoder.withSecretKey(jwtSecretKey).macAlgorithm(MacAlgorithm.HS256).build();
	}

	@Bean
	SecurityFilterChain apiSecurity(HttpSecurity http,
			@Value("${app.auth.http-enforcement-enabled:true}") boolean httpEnforcementEnabled) throws Exception {
		http.csrf(AbstractHttpConfigurer::disable)
				.sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS));

		if (httpEnforcementEnabled) {
			http.authorizeHttpRequests(requests -> requests
							.requestMatchers(
									"/api/v1/auth/register",
									"/api/v1/auth/login",
									"/api/v1/auth/refresh")
							.permitAll()
							.requestMatchers("/actuator/health/**")
							.permitAll()
							.requestMatchers("/v3/api-docs/**", "/swagger-ui/**")
							.permitAll()
							.anyRequest()
							.authenticated())
					.oauth2ResourceServer(resourceServer -> resourceServer.jwt(Customizer.withDefaults()));
		}
		else {
			http.authorizeHttpRequests(requests -> requests.anyRequest().permitAll());
		}

		return http.build();
	}

}
