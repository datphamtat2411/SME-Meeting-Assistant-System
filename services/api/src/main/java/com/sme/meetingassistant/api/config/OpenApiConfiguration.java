package com.sme.meetingassistant.api.config;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import org.springdoc.core.customizers.OpenApiCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
public class OpenApiConfiguration {

	@Bean
	OpenAPI meetingAssistantOpenApi() {
		return new OpenAPI().info(new Info().title("SME Meeting Assistant API").version("1.0.0"));
	}

	@Bean
	OpenApiCustomizer businessPathFilter() {
		return openAPI -> {
			if (openAPI.getPaths() != null) {
				openAPI.getPaths().entrySet().removeIf(entry -> !entry.getKey().startsWith("/api/v1/"));
			}
		};
	}

}
