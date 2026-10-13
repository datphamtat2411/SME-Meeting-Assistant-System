package com.sme.meetingassistant.api.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;
import org.springframework.web.filter.CorsFilter;

@Configuration(proxyBeanMethods = false)
public class HttpSecurityConfiguration {

	private final HttpSecurityProperties properties;

	public HttpSecurityConfiguration(HttpSecurityProperties properties, RuntimeProperties runtimeProperties) {
		this.properties = properties;
		this.properties.validate(runtimeProperties.getEnvironment());
	}

	@Bean
	CorsFilter corsFilter() {
		HttpSecurityProperties.Cors corsProperties = this.properties.getCors();
		CorsConfiguration corsConfiguration = new CorsConfiguration();
		corsConfiguration.setAllowedOrigins(corsProperties.getAllowedOrigins());
		corsConfiguration.setAllowedMethods(corsProperties.getAllowedMethods());
		corsConfiguration.setAllowedHeaders(corsProperties.getAllowedHeaders());
		corsConfiguration.setExposedHeaders(corsProperties.getExposedHeaders());
		corsConfiguration.setAllowCredentials(corsProperties.isAllowCredentials());
		corsConfiguration.setMaxAge(corsProperties.getMaxAge().toSeconds());

		UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
		source.registerCorsConfiguration("/api/v1/**", corsConfiguration);
		return new OrderedCorsFilter(source);
	}

	@Bean
	SecurityHeadersFilter securityHeadersFilter() {
		return new SecurityHeadersFilter(this.properties.getHsts());
	}

	private static final class OrderedCorsFilter extends CorsFilter implements Ordered {

		private OrderedCorsFilter(UrlBasedCorsConfigurationSource source) {
			super(source);
		}

		@Override
		public int getOrder() {
			return Ordered.HIGHEST_PRECEDENCE + 2;
		}

	}

}
