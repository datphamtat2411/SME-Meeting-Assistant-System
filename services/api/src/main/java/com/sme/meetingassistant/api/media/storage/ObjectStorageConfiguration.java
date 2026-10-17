package com.sme.meetingassistant.api.media.storage;

import io.minio.MinioClient;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "app.media.storage", name = "enabled", havingValue = "true")
@EnableConfigurationProperties(ObjectStorageProperties.class)
public class ObjectStorageConfiguration {

	@Bean
	MinioClient minioClient(ObjectStorageProperties properties) {
		return MinioClient.builder()
				.endpoint(properties.getEndpoint())
				.credentials(properties.getAccessKey(), properties.getSecretKey())
				.build();
	}

	@Bean
	ObjectStorage objectStorage(MinioClient minioClient, ObjectStorageProperties properties) {
		return new MinioObjectStorageAdapter(minioClient, properties.getBucket());
	}

}
