package com.sme.meetingassistant.api.config;

import jakarta.validation.constraints.NotBlank;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "app.runtime")
public class RuntimeProperties {

	@NotBlank(message = "must be set via APP_ENVIRONMENT (app.runtime.environment)")
	private String environment;

	private RequestId requestId = new RequestId();

	public String getEnvironment() {
		return this.environment;
	}

	public void setEnvironment(String environment) {
		this.environment = environment;
	}

	public RequestId getRequestId() {
		return this.requestId;
	}

	public void setRequestId(RequestId requestId) {
		this.requestId = requestId == null ? new RequestId() : requestId;
	}

	public static class RequestId {

		private List<String> trustedProxies = List.of();

		public List<String> getTrustedProxies() {
			return this.trustedProxies;
		}

		public void setTrustedProxies(List<String> trustedProxies) {
			this.trustedProxies = trustedProxies == null ? List.of() : List.copyOf(trustedProxies);
		}

	}

}
