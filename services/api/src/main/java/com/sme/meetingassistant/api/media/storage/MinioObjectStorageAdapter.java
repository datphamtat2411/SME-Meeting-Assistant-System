package com.sme.meetingassistant.api.media.storage;

import io.minio.BucketExistsArgs;
import io.minio.MakeBucketArgs;
import io.minio.MinioClient;
import io.minio.PutObjectArgs;
import io.minio.RemoveObjectArgs;
import java.io.InputStream;
import java.util.Objects;

public class MinioObjectStorageAdapter implements ObjectStorage {

	private final MinioClient minioClient;
	private final String bucket;
	private volatile boolean bucketReady;

	public MinioObjectStorageAdapter(MinioClient minioClient, String bucket) {
		this.minioClient = Objects.requireNonNull(minioClient, "minioClient must not be null");
		if (bucket == null || bucket.isBlank()) {
			throw new IllegalArgumentException("bucket must not be blank");
		}
		this.bucket = bucket;
	}

	@Override
	public void store(String objectKey, InputStream content, long size, String contentType) {
		if (objectKey == null || objectKey.isBlank()) {
			throw new IllegalArgumentException("objectKey must not be blank");
		}
		Objects.requireNonNull(content, "content must not be null");
		if (size < 0) {
			throw new IllegalArgumentException("size must not be negative");
		}
		if (contentType == null || contentType.isBlank()) {
			throw new IllegalArgumentException("contentType must not be blank");
		}

		try {
			ensureBucket();
			this.minioClient.putObject(PutObjectArgs.builder()
					.bucket(this.bucket)
					.object(objectKey)
					.stream(content, size, null)
					.contentType(contentType)
					.build());
		}
		catch (Exception exception) {
			throw new ObjectStorageException(exception);
		}
	}

	@Override
	public void delete(String objectKey) {
		if (objectKey == null || objectKey.isBlank()) {
			throw new IllegalArgumentException("objectKey must not be blank");
		}
		try {
			this.minioClient.removeObject(RemoveObjectArgs.builder().bucket(this.bucket).object(objectKey).build());
		}
		catch (Exception exception) {
			throw new ObjectStorageException(exception);
		}
	}

	private void ensureBucket() throws Exception {
		if (this.bucketReady) {
			return;
		}
		synchronized (this) {
			if (this.bucketReady) {
				return;
			}
			if (!this.minioClient.bucketExists(BucketExistsArgs.builder().bucket(this.bucket).build())) {
				try {
					this.minioClient.makeBucket(MakeBucketArgs.builder().bucket(this.bucket).build());
				}
				catch (Exception creationFailure) {
					if (!this.minioClient.bucketExists(BucketExistsArgs.builder().bucket(this.bucket).build())) {
						throw creationFailure;
					}
				}
			}
			this.bucketReady = true;
		}
	}

}
