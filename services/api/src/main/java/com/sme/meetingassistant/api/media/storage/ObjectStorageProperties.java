package com.sme.meetingassistant.api.media.storage;

import jakarta.validation.constraints.AssertTrue;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "app.media.storage")
public class ObjectStorageProperties {

	private boolean enabled;

	private String endpoint;

	private String accessKey;

	private String secretKey;

	private String bucket;

	@AssertTrue(message = "Storage endpoint, credentials, and bucket are required when storage is enabled")
	public boolean isConfigurationCompleteWhenEnabled() {
		return !this.enabled || hasText(this.endpoint) && hasText(this.accessKey) && hasText(this.secretKey)
				&& hasText(this.bucket);
	}

	private static boolean hasText(String value) {
		return value != null && !value.isBlank();
	}

	public boolean isEnabled() {
		return this.enabled;
	}

	public void setEnabled(boolean enabled) {
		this.enabled = enabled;
	}

	public String getEndpoint() {
		return this.endpoint;
	}

	public void setEndpoint(String endpoint) {
		this.endpoint = endpoint;
	}

	public String getAccessKey() {
		return this.accessKey;
	}

	public void setAccessKey(String accessKey) {
		this.accessKey = accessKey;
	}

	public String getSecretKey() {
		return this.secretKey;
	}

	public void setSecretKey(String secretKey) {
		this.secretKey = secretKey;
	}

	public String getBucket() {
		return this.bucket;
	}

	public void setBucket(String bucket) {
		this.bucket = bucket;
	}

}
